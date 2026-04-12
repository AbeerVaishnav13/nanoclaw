import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  DEFAULT_TRIGGER,
  getTriggerPattern,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAX_MESSAGES_PER_PROMPT,
  POLL_INTERVAL,
  TIMEZONE,
} from './config.js';

const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT || '3001',
  10,
);
import { startCredentialProxy } from './credential-proxy.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerInputImage,
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
} from './container-runtime.js';

const PROXY_BIND_HOST = process.env.CREDENTIAL_PROXY_HOST || '0.0.0.0';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  deleteSession,
  getAllTasks,
  getLastBotMessageTimestamp,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import { ChannelType } from './text-styles.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import {
  extractSessionCommand,
  handleSessionCommand,
  isSessionCommandAllowed,
} from './session-commands.js';
import { startSessionCleanup } from './session-cleanup.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { validateMount, expandPath } from './mount-security.js';
import {
  AdditionalMount,
  Channel,
  NewMessage,
  RegisteredGroup,
} from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

// --- Per-group settings (model preference, etc.) ---
interface GroupSettings {
  model?: string;
}

import { MODEL_ALIASES, modelSupportsImages } from './models.js';

function readGroupSettings(folder: string): GroupSettings {
  try {
    const settingsPath = path.join(
      resolveGroupFolderPath(folder),
      'nanoclaw.settings.json',
    );
    return JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch {
    return {};
  }
}

function writeGroupSettings(folder: string, settings: GroupSettings): void {
  const settingsPath = path.join(
    resolveGroupFolderPath(folder),
    'nanoclaw.settings.json',
  );
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
}

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

// In-memory image cache: message ID → image attachments (transient, not stored in DB)
// Evicted after the message is processed by the container agent.
const pendingImages = new Map<string, ContainerInputImage[]>();

const channels: Channel[] = [];

/**
 * Dedup tracker: prevents the same message from being sent twice when
 * the agent both calls send_message (IPC) and returns the same text as a result.
 * Keys are `${chatJid}\0${text}`, entries expire after 10 seconds.
 */
const recentSends = new Map<string, number>();
const DEDUP_TTL_MS = 10_000;

function markSent(chatJid: string, text: string): void {
  recentSends.set(`${chatJid}\0${text}`, Date.now());
}

function wasSentRecently(chatJid: string, text: string): boolean {
  const key = `${chatJid}\0${text}`;
  const ts = recentSends.get(key);
  if (!ts) return false;
  if (Date.now() - ts > DEDUP_TTL_MS) {
    recentSends.delete(key);
    return false;
  }
  return true;
}

// Periodic cleanup of stale dedup entries
setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of recentSends) {
    if (now - ts > DEDUP_TTL_MS) recentSends.delete(key);
  }
}, 30_000);
const queue = new GroupQueue();

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

/**
 * Return the message cursor for a group, recovering from the last bot reply
 * if lastAgentTimestamp is missing (new group, corrupted state, restart).
 */
function getOrRecoverCursor(chatJid: string): string {
  const existing = lastAgentTimestamp[chatJid];
  if (existing) return existing;

  const botTs = getLastBotMessageTimestamp(chatJid, ASSISTANT_NAME);
  if (botTs) {
    logger.info(
      { chatJid, recoveredFrom: botTs },
      'Recovered message cursor from last bot reply',
    );
    lastAgentTimestamp[chatJid] = botTs;
    saveState();
    return botTs;
  }
  return '';
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Copy CLAUDE.md template into the new group folder so agents have
  // identity and instructions from the first run.  (Fixes #1391)
  const groupMdFile = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(groupMdFile)) {
    const templateFile = path.join(
      GROUPS_DIR,
      group.isMain ? 'main' : 'global',
      'CLAUDE.md',
    );
    if (fs.existsSync(templateFile)) {
      let content = fs.readFileSync(templateFile, 'utf-8');
      if (ASSISTANT_NAME !== 'Andy') {
        content = content.replace(/^# Andy$/m, `# ${ASSISTANT_NAME}`);
        content = content.replace(/You are Andy/g, `You are ${ASSISTANT_NAME}`);
      }
      fs.writeFileSync(groupMdFile, content);
      logger.info({ folder: group.folder }, 'Created CLAUDE.md from template');
    }
  }

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const missedMessages = getMessagesSince(
    chatJid,
    getOrRecoverCursor(chatJid),
    ASSISTANT_NAME,
    MAX_MESSAGES_PER_PROMPT,
  );

  if (missedMessages.length === 0) return true;

  // Re-attach cached images — they are transient and not stored in DB
  for (const msg of missedMessages) {
    const cached = pendingImages.get(msg.id);
    if (cached) msg.images = cached;
  }

  // --- Session command interception (before trigger check) ---
  const cmdResult = await handleSessionCommand({
    missedMessages,
    isMainGroup,
    groupName: group.name,
    triggerPattern: getTriggerPattern(group.trigger),
    timezone: TIMEZONE,
    deps: {
      sendMessage: (text) => channel.sendMessage(chatJid, text),
      setTyping: (typing) =>
        channel.setTyping?.(chatJid, typing) ?? Promise.resolve(),
      runAgent: (prompt, onOutput) =>
        runAgent(group, prompt, chatJid, undefined, onOutput),
      closeStdin: () => queue.closeStdin(chatJid),
      advanceCursor: (ts) => {
        lastAgentTimestamp[chatJid] = ts;
        saveState();
      },
      formatMessages,
      canSenderInteract: (msg) => {
        const hasTrigger = getTriggerPattern(group.trigger).test(
          msg.content.trim(),
        );
        const reqTrigger = !isMainGroup && group.requiresTrigger !== false;
        return (
          isMainGroup ||
          !reqTrigger ||
          (hasTrigger &&
            (msg.is_from_me ||
              isTriggerAllowed(chatJid, msg.sender, loadSenderAllowlist())))
        );
      },
    },
  });
  if (cmdResult.handled) return cmdResult.success;
  // --- End session command interception ---

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const triggerPattern = getTriggerPattern(group.trigger);
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        triggerPattern.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) {
      return true;
    }
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);

  // Collect image attachments from triggering messages (transient, not stored in DB)
  const images = missedMessages.flatMap((m) => m.images ?? []);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(
    group,
    prompt,
    chatJid,
    images.length > 0 ? images : undefined,
    async (result) => {
      // Streaming output callback — called for each agent result
      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        logger.info({ group: group.name }, `Agent output: ${raw.length} chars`);
        if (text) {
          if (wasSentRecently(chatJid, text)) {
            logger.debug(
              { group: group.name },
              'Skipping duplicate agent output (already sent via IPC)',
            );
          } else {
            markSent(chatJid, text);
            await channel.sendMessage(chatJid, text);
          }
          outputSentToUser = true;
        }
        // Only reset idle timer on actual results, not session-update markers (result: null)
        resetIdleTimer();
      }

      if (result.status === 'success') {
        queue.notifyIdle(chatJid);
      }

      if (result.status === 'error') {
        hadError = true;
      }
    },
  );

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  // Evict processed images from cache
  for (const msg of missedMessages) {
    pendingImages.delete(msg.id);
  }

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  images?: ContainerInputImage[],
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script || undefined,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  const groupSettings = readGroupSettings(group.folder);

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        model: groupSettings.model,
        images,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      // Detect stale/corrupt session — clear it so the next retry starts fresh.
      // The session .jsonl can go missing after a crash mid-write, manual
      // deletion, or disk-full. The existing backoff in group-queue.ts
      // handles the retry; we just need to remove the broken session ID.
      const isStaleSession =
        sessionId &&
        output.error &&
        /no conversation found|ENOENT.*\.jsonl|session.*not found/i.test(
          output.error,
        );

      if (isStaleSession) {
        logger.warn(
          { group: group.name, staleSessionId: sessionId, error: output.error },
          'Stale session detected — clearing for next retry',
        );
        delete sessions[group.folder];
        deleteSession(group.folder);
      }

      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (default trigger: ${DEFAULT_TRIGGER})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;

          // --- Session command interception (message loop) ---
          // Scan ALL messages in the batch for a session command.
          const loopCmdMsg = groupMessages.find(
            (m) =>
              extractSessionCommand(
                m.content,
                getTriggerPattern(group.trigger),
              ) !== null,
          );

          if (loopCmdMsg) {
            // Only close active container if the sender is authorized — otherwise an
            // untrusted user could kill in-flight work by sending /compact (DoS).
            // closeStdin no-ops internally when no container is active.
            if (
              isSessionCommandAllowed(
                isMainGroup,
                loopCmdMsg.is_from_me === true,
              )
            ) {
              queue.closeStdin(chatJid);
            }
            // Enqueue so processGroupMessages handles auth + cursor advancement.
            // Don't pipe via IPC — slash commands need a fresh container with
            // string prompt (not MessageStream) for SDK recognition.
            queue.enqueueMessageCheck(chatJid);
            continue;
          }
          // --- End session command interception ---

          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const triggerPattern = getTriggerPattern(group.trigger);
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                triggerPattern.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            getOrRecoverCursor(chatJid),
            ASSISTANT_NAME,
            MAX_MESSAGES_PER_PROMPT,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          // Re-attach cached images for piped messages
          for (const msg of messagesToSend) {
            const cached = pendingImages.get(msg.id);
            if (cached) msg.images = cached;
          }
          const formatted = formatMessages(messagesToSend, TIMEZONE);
          const pipedImages = messagesToSend.flatMap((m) => m.images ?? []);

          if (
            queue.sendMessage(
              chatJid,
              formatted,
              pipedImages.length > 0 ? pipedImages : undefined,
            )
          ) {
            // Evict piped images from cache
            for (const msg of messagesToSend) {
              pendingImages.delete(msg.id);
            }
            logger.info(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const pending = getMessagesSince(
      chatJid,
      getOrRecoverCursor(chatJid),
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
    );
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();
  restoreRemoteControl();

  // Start credential proxy (containers route API calls through this)
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
  );

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    proxyServer.close();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Handle built-in slash commands (/new, /model, /help, /restart)
  async function handleCommand(
    trimmed: string,
    chatJid: string,
  ): Promise<boolean> {
    const group = registeredGroups[chatJid];
    if (!group) return false;
    const channel = findChannel(channels, chatJid);
    if (!channel) return false;

    if (trimmed === '/new') {
      delete sessions[group.folder];
      setSession(group.folder, '');
      saveState();
      await channel.sendMessage(chatJid, 'Started a new conversation.');
      return true;
    }

    if (trimmed === '/help') {
      const settings = readGroupSettings(group.folder);
      const currentModel = settings.model || 'claude-sonnet-4-6';
      await channel.sendMessage(
        chatJid,
        [
          'Available commands:',
          '  /new — start a fresh conversation (clear session)',
          '  /model — show current model',
          '  /model <name> — set model (e.g. claude-sonnet-4-6, claude-opus-4-6, claude-haiku-4-5-20251001)',
          '  /mount-dir <path> [rw] — mount a directory from the allowlist',
          '  /unmount-dir <host-path> — unmount a directory from the agent container',
          '  /la — list all mounted directories with file tree',
          '  /ls <path> — list files in a mounted directory (e.g. /ls myrepo/src)',
          '  /restart — restart nanoclaw (launchd will auto-restart)',
          '  /build-restart — build then restart nanoclaw',
          '  /rebuild-all — npm build, container build, then restart',
          '  /update-nanoclaw — pull upstream updates, build, and restart',
          '  /help — show this help',
          '',
          `Current model: ${currentModel}`,
        ].join('\n'),
      );
      return true;
    }

    if (trimmed === '/model') {
      const settings = readGroupSettings(group.folder);
      const currentModel = settings.model || 'claude-sonnet-4-6';
      await channel.sendMessage(chatJid, `Current model: ${currentModel}`);
      return true;
    }

    if (trimmed.startsWith('/model ')) {
      const arg = trimmed.slice('/model '.length).trim();
      const resolved = MODEL_ALIASES[arg] || arg;
      const settings = readGroupSettings(group.folder);
      const previousModel = settings.model || 'claude-sonnet-4-6';
      settings.model = resolved;
      writeGroupSettings(group.folder, settings);
      // Clear session when model changes to avoid incompatible conversation history
      if (resolved !== previousModel) {
        delete sessions[group.folder];
        setSession(group.folder, '');
        saveState();
        await channel.sendMessage(
          chatJid,
          `Model set to: ${resolved} (new conversation started)`,
        );
        await channel.sendMessage(chatJid, 'Restarting... be right back!');
        logger.info(`Model changed to ${resolved}, restarting...`);
        setTimeout(() => process.exit(0), 500);
      } else {
        await channel.sendMessage(chatJid, `Model set to: ${resolved}`);
      }
      return true;
    }

    if (trimmed === '/restart') {
      await channel.sendMessage(
        chatJid,
        'Restarting nanoclaw... be right back!',
      );
      logger.info('Restart requested via /restart command');
      setTimeout(() => process.exit(0), 500);
      return true;
    }

    if (trimmed === '/build-restart') {
      await channel.sendMessage(chatJid, 'Building nanoclaw...');
      logger.info('Build+restart requested via /build-restart command');
      const { exec } = await import('child_process');
      exec(
        'npm run build',
        { cwd: process.cwd() },
        async (err, stdout, stderr) => {
          if (err) {
            logger.error({ err, stderr }, 'Build failed');
            await channel.sendMessage(
              chatJid,
              `Build failed:\n${stderr || err.message}`,
            );
            return;
          }
          await channel.sendMessage(
            chatJid,
            'Build succeeded! Restarting... be right back!',
          );
          logger.info('Build succeeded, restarting');
          setTimeout(() => process.exit(0), 500);
        },
      );
      return true;
    }

    if (trimmed === '/rebuild-container') {
      await channel.sendMessage(
        chatJid,
        'Rebuilding Docker container image...',
      );
      logger.info('Container rebuild requested via /rebuild-container command');
      const { exec } = await import('child_process');
      exec(
        'CONTAINER_RUNTIME=docker ./container/build.sh',
        { cwd: process.cwd() },
        async (err, stdout, stderr) => {
          if (err) {
            logger.error({ err, stderr }, 'Container build failed');
            await channel.sendMessage(
              chatJid,
              `Container build failed:\n${stderr || err.message}`,
            );
            return;
          }
          await channel.sendMessage(
            chatJid,
            'Container image rebuilt successfully! ✅',
          );
          logger.info('Container build succeeded');
        },
      );
      return true;
    }

    if (trimmed === '/rebuild-all') {
      await channel.sendMessage(chatJid, 'Step 1/3: Running npm build...');
      logger.info('Full rebuild requested via /rebuild-all command');
      const { exec } = await import('child_process');
      const cwd = process.cwd();
      exec('npm run build', { cwd }, async (err, stdout, stderr) => {
        if (err) {
          logger.error({ err, stderr }, 'npm build failed');
          await channel.sendMessage(
            chatJid,
            `Step 1/3 failed — npm build:\n${stderr || err.message}`,
          );
          return;
        }
        await channel.sendMessage(
          chatJid,
          'Step 1/3 done ✅  Step 2/3: Rebuilding container image...',
        );
        logger.info('npm build succeeded, starting container build');
        exec(
          'CONTAINER_RUNTIME=docker ./container/build.sh',
          { cwd },
          async (err2, stdout2, stderr2) => {
            if (err2) {
              logger.error(
                { err: err2, stderr: stderr2 },
                'Container build failed',
              );
              await channel.sendMessage(
                chatJid,
                `Step 2/3 failed — container build:\n${stderr2 || err2.message}`,
              );
              return;
            }
            await channel.sendMessage(
              chatJid,
              'Step 2/3 done ✅  Step 3/3: Restarting... be right back!',
            );
            logger.info('Full rebuild succeeded, restarting');
            setTimeout(() => process.exit(0), 500);
          },
        );
      });
      return true;
    }

    if (trimmed === '/update-nanoclaw') {
      await channel.sendMessage(chatJid, 'Pulling upstream updates...');
      logger.info('Update requested via /update-nanoclaw command');
      const { exec } = await import('child_process');
      const cwd = process.cwd();
      exec(
        `git pull "https://${process.env.GITHUB_TOKEN ? `${process.env.GITHUB_TOKEN}@` : ''}github.com/AbeerVaishnav13/nanoclaw.git" main && npm install && npm run build`,
        { cwd },
        async (err, stdout, stderr) => {
          if (err) {
            logger.error({ err, stderr }, 'Update failed');
            await channel.sendMessage(
              chatJid,
              `Update failed:\n${stderr || err.message}`,
            );
            return;
          }
          await channel.sendMessage(
            chatJid,
            'Update succeeded! Restarting... be right back!',
          );
          logger.info('Update succeeded, restarting');
          setTimeout(() => process.exit(0), 500);
        },
      );
      return true;
    }

    if (trimmed.startsWith('/mount-dir ')) {
      const args = trimmed.slice('/mount-dir '.length).trim().split(/\s+/);
      const hostPath = args[0];
      if (!hostPath) {
        await channel.sendMessage(chatJid, 'Usage: /mount-dir <path> [rw]');
        return true;
      }
      const isRw = args.includes('rw');
      const containerPath = path.basename(expandPath(hostPath));

      const mount: AdditionalMount = {
        hostPath,
        containerPath,
        readonly: !isRw,
      };

      const result = validateMount(mount, group.isMain === true);
      if (!result.allowed) {
        await channel.sendMessage(chatJid, `Mount rejected: ${result.reason}`);
        return true;
      }

      // Add to group config
      if (!group.containerConfig) group.containerConfig = {};
      if (!group.containerConfig.additionalMounts)
        group.containerConfig.additionalMounts = [];

      // Check for duplicate
      const existing = group.containerConfig.additionalMounts.find(
        (m) => (m.containerPath || path.basename(m.hostPath)) === containerPath,
      );
      if (existing) {
        await channel.sendMessage(
          chatJid,
          `Already mounted as "${containerPath}". Unmount first to change.`,
        );
        return true;
      }

      group.containerConfig.additionalMounts.push(mount);
      setRegisteredGroup(chatJid, group);
      registeredGroups[chatJid] = group;

      const rwLabel = result.effectiveReadonly ? 'ro' : 'rw';
      await channel.sendMessage(
        chatJid,
        `Mounted: /workspace/extra/${containerPath} <- ${hostPath} [${rwLabel}]`,
      );
      return true;
    }

    if (trimmed.startsWith('/unmount-dir ')) {
      const mountPath = trimmed.slice('/unmount-dir '.length).trim();
      if (!mountPath) {
        await channel.sendMessage(chatJid, 'Usage: /unmount-dir <host-path>');
        return true;
      }

      const mounts = group.containerConfig?.additionalMounts || [];
      const idx = mounts.findIndex((m) => m.hostPath === mountPath);
      if (idx === -1) {
        await channel.sendMessage(
          chatJid,
          `No mount for "${mountPath}" found.`,
        );
        return true;
      }

      mounts.splice(idx, 1);
      if (!group.containerConfig) group.containerConfig = {};
      group.containerConfig.additionalMounts = mounts;
      setRegisteredGroup(chatJid, group);
      registeredGroups[chatJid] = group;

      await channel.sendMessage(chatJid, `Unmounted: ${mountPath}`);
      return true;
    }

    if (trimmed === '/la') {
      const mounts = group.containerConfig?.additionalMounts || [];
      if (mounts.length === 0) {
        await channel.sendMessage(chatJid, 'No extra directories mounted.');
        return true;
      }
      const lines: string[] = ['Mounted directories:', '', '```'];
      for (const m of mounts) {
        const containerName = m.containerPath || path.basename(m.hostPath);
        const rwLabel = m.readonly === false ? 'rw' : 'ro';
        lines.push(
          `/workspace/extra/${containerName} <- ${m.hostPath} [${rwLabel}]`,
        );
        try {
          const expanded = expandPath(m.hostPath);
          const topEntries = fs.readdirSync(expanded, { withFileTypes: true });
          const capped = topEntries.slice(0, 30);
          for (let i = 0; i < capped.length; i++) {
            const entry = capped[i];
            const isLast = i === capped.length - 1 && topEntries.length <= 30;
            const connector = isLast
              ? '\u2514\u2500\u2500'
              : '\u251C\u2500\u2500';
            const suffix = entry.isDirectory() ? '/' : '';
            lines.push(`${connector} ${entry.name}${suffix}`);
            // Recurse into visible directories only (skip hidden dirs)
            if (entry.isDirectory() && !entry.name.startsWith('.')) {
              const pipe = isLast ? '    ' : '\u2502   ';
              try {
                const subEntries = fs.readdirSync(
                  path.join(expanded, entry.name),
                  { withFileTypes: true },
                );
                const subCapped = subEntries.slice(0, 15);
                for (let j = 0; j < subCapped.length; j++) {
                  const sub = subCapped[j];
                  const subIsLast =
                    j === subCapped.length - 1 && subEntries.length <= 15;
                  const subConnector = subIsLast
                    ? '\u2514\u2500\u2500'
                    : '\u251C\u2500\u2500';
                  const subSuffix = sub.isDirectory() ? '/' : '';
                  lines.push(`${pipe}${subConnector} ${sub.name}${subSuffix}`);
                }
                if (subEntries.length > 15) {
                  lines.push(
                    `${pipe}\u2514\u2500\u2500 ... and ${subEntries.length - 15} more`,
                  );
                }
              } catch {
                // Permission denied or other read error
              }
            }
          }
          if (topEntries.length > 30) {
            lines.push(
              `\u2514\u2500\u2500 ... and ${topEntries.length - 30} more`,
            );
          }
        } catch {
          lines.push('(unable to read directory)');
        }
      }
      lines.push('```');
      await channel.sendMessage(chatJid, lines.join('\n'));
      return true;
    }

    if (trimmed.startsWith('/ls ')) {
      const rawArg = trimmed.slice('/ls '.length).trim();
      if (!rawArg) {
        await channel.sendMessage(
          chatJid,
          'Usage: /ls <path> (e.g. /ls myrepo/src)',
        );
        return true;
      }

      // Auto-prepend /workspace/extra/ so the user only types the relative part
      const containerPath = rawArg.startsWith('/workspace/extra/')
        ? rawArg
        : `/workspace/extra/${rawArg.replace(/^\/+/, '')}`;

      const mounts = group.containerConfig?.additionalMounts || [];
      let matchedMount: AdditionalMount | null = null;
      let mountPrefix = '';

      for (const m of mounts) {
        const containerName = m.containerPath || path.basename(m.hostPath);
        const prefix = `/workspace/extra/${containerName}`;
        if (
          containerPath === prefix ||
          containerPath.startsWith(prefix + '/')
        ) {
          matchedMount = m;
          mountPrefix = prefix;
          break;
        }
      }

      if (!matchedMount) {
        await channel.sendMessage(
          chatJid,
          'Path not found in any mounted directory.',
        );
        return true;
      }

      const expanded = expandPath(matchedMount.hostPath);
      const relativePath = containerPath.slice(mountPrefix.length);
      const hostPath = relativePath
        ? path.join(expanded, relativePath)
        : expanded;

      try {
        const entries = fs.readdirSync(hostPath, { withFileTypes: true });
        const capped = entries.slice(0, 50);
        const lines: string[] = [`${containerPath}:`, '', '```'];
        for (let i = 0; i < capped.length; i++) {
          const entry = capped[i];
          const isLast = i === capped.length - 1 && entries.length <= 50;
          const connector = isLast
            ? '\u2514\u2500\u2500'
            : '\u251C\u2500\u2500';
          const suffix = entry.isDirectory() ? '/' : '';
          lines.push(`${connector} ${entry.name}${suffix}`);
        }
        if (entries.length > 50) {
          lines.push(`\u2514\u2500\u2500 ... and ${entries.length - 50} more`);
        }
        lines.push('```');
        await channel.sendMessage(chatJid, lines.join('\n'));
      } catch {
        await channel.sendMessage(chatJid, `Unable to read: ${containerPath}`);
      }
      return true;
    }

    return false;
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Built-in slash commands — intercept before storage
      if (trimmed.startsWith('/')) {
        handleCommand(trimmed, chatJid)
          .then((handled) => {
            if (!handled) {
              // Unknown command — pass through to agent as a regular message
              storeMessage(msg);
            }
          })
          .catch((err) => logger.error({ err, chatJid }, 'Command error'));
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      // Cache images before storing to DB (images are transient, not persisted)
      if (msg.images && msg.images.length > 0) {
        pendingImages.set(msg.id, msg.images);
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText, channel.name as ChannelType);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      const text = formatOutbound(rawText, channel.name as ChannelType);
      if (!text) return Promise.resolve();
      markSent(jid, text);
      return channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
  });
  startSessionCleanup();
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
