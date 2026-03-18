import {
  Client,
  Events,
  GatewayIntentBits,
  Interaction,
  Message,
  REST,
  Routes,
  SlashCommandBuilder,
  TextChannel,
} from 'discord.js';
import sharp from 'sharp';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  ImageAttachment,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

/** Discord Application Commands — these show autocomplete when users type "/" */
const SLASH_COMMANDS = [
  new SlashCommandBuilder()
    .setName('new')
    .setDescription('Start a fresh conversation (clear session)'),
  new SlashCommandBuilder()
    .setName('model')
    .setDescription('Show or set the current model')
    .addStringOption((opt) =>
      opt
        .setName('name')
        .setDescription('Model to use')
        .setRequired(false)
        .addChoices(
          { name: 'claude-sonnet-4-6', value: 'claude-sonnet-4-6' },
          { name: 'claude-opus-4-6', value: 'claude-opus-4-6' },
          { name: 'claude-haiku-4-5-20251001', value: 'claude-haiku-4-5-20251001' },
        ),
    ),
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show available commands'),
  new SlashCommandBuilder()
    .setName('restart')
    .setDescription('Restart nanoclaw (launchd will auto-restart)'),
  new SlashCommandBuilder()
    .setName('build-restart')
    .setDescription('Build then restart nanoclaw'),
  new SlashCommandBuilder()
    .setName('update-nanoclaw')
    .setDescription('Pull upstream NanoClaw updates, build, and restart'),
];

/** Max pixel dimension for images passed to Claude. Keeps token cost low. */
const IMAGE_MAX_PX = 1024;
/** JPEG quality for compressed images (75 = good quality, ~60% smaller). */
const IMAGE_JPEG_QUALITY = 75;

/**
 * Download a Discord image URL, resize to IMAGE_MAX_PX on longest side,
 * and return a base64-encoded JPEG for the Claude multimodal API.
 */
async function fetchAndResizeImage(url: string, name: string): Promise<ImageAttachment | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      logger.warn({ url, status: res.status }, 'Failed to fetch Discord image');
      return null;
    }
    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const resized = await sharp(buffer)
      .resize(IMAGE_MAX_PX, IMAGE_MAX_PX, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: IMAGE_JPEG_QUALITY })
      .toBuffer();

    return {
      data: resized.toString('base64'),
      media_type: 'image/jpeg',
      name,
    };
  } catch (err) {
    logger.warn({ url, err }, 'Failed to process Discord image attachment');
    return null;
  }
}

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: DiscordChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });

    this.client.on(Events.MessageCreate, async (message: Message) => {
      // Ignore bot messages (including own)
      if (message.author.bot) return;

      const channelId = message.channelId;
      const chatJid = `dc:${channelId}`;
      let content = message.content;
      const timestamp = message.createdAt.toISOString();
      const senderName =
        message.member?.displayName ||
        message.author.displayName ||
        message.author.username;
      const sender = message.author.id;
      const msgId = message.id;

      // Determine chat name
      let chatName: string;
      if (message.guild) {
        const textChannel = message.channel as TextChannel;
        chatName = `${message.guild.name} #${textChannel.name}`;
      } else {
        chatName = senderName;
      }

      // Translate Discord @bot mentions into TRIGGER_PATTERN format.
      // Discord mentions look like <@botUserId> — these won't match
      // TRIGGER_PATTERN (e.g., ^@Andy\b), so we prepend the trigger
      // when the bot is @mentioned.
      if (this.client?.user) {
        const botId = this.client.user.id;
        const isBotMentioned =
          message.mentions.users.has(botId) ||
          content.includes(`<@${botId}>`) ||
          content.includes(`<@!${botId}>`);

        if (isBotMentioned) {
          // Strip the <@botId> mention to avoid visual clutter
          content = content
            .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
            .trim();
          // Prepend trigger if not already present
          if (!TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
        }
      }

      // Handle attachments — download and resize images, store placeholders for others
      const imageAttachments: ImageAttachment[] = [];
      if (message.attachments.size > 0) {
        const attachmentDescriptions: string[] = [];
        for (const att of message.attachments.values()) {
          const contentType = att.contentType || '';
          if (contentType.startsWith('image/')) {
            attachmentDescriptions.push(`[Image: ${att.name || 'image'}]`);
            const img = await fetchAndResizeImage(att.url, att.name || 'image');
            if (img) imageAttachments.push(img);
          } else if (contentType.startsWith('video/')) {
            attachmentDescriptions.push(`[Video: ${att.name || 'video'}]`);
          } else if (contentType.startsWith('audio/')) {
            attachmentDescriptions.push(`[Audio: ${att.name || 'audio'}]`);
          } else {
            attachmentDescriptions.push(`[File: ${att.name || 'file'}]`);
          }
        }
        if (content) {
          content = `${content}\n${attachmentDescriptions.join('\n')}`;
        } else {
          content = attachmentDescriptions.join('\n');
        }
      }

      // Handle reply context — include who the user is replying to
      if (message.reference?.messageId) {
        try {
          const repliedTo = await message.channel.messages.fetch(
            message.reference.messageId,
          );
          const replyAuthor =
            repliedTo.member?.displayName ||
            repliedTo.author.displayName ||
            repliedTo.author.username;
          content = `[Reply to ${replyAuthor}] ${content}`;
        } catch {
          // Referenced message may have been deleted
        }
      }

      // Store chat metadata for discovery
      const isGroup = message.guild !== null;
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'discord',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Discord channel',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        images: imageAttachments.length > 0 ? imageAttachments : undefined,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Discord message stored',
      );
    });

    // Handle slash command interactions
    this.client.on(Events.InteractionCreate, async (interaction: Interaction) => {
      if (!interaction.isChatInputCommand()) return;

      const channelId = interaction.channelId;
      const chatJid = `dc:${channelId}`;
      const sender = interaction.user.id;
      const senderName =
        interaction.guild
          ? (interaction.member as any)?.displayName || interaction.user.displayName || interaction.user.username
          : interaction.user.displayName || interaction.user.username;
      const timestamp = interaction.createdAt.toISOString();

      // Build equivalent text command
      let textCommand = `/${interaction.commandName}`;
      const modelArg = interaction.options.getString('name');
      if (modelArg) textCommand += ` ${modelArg}`;

      // Acknowledge the interaction ephemerally
      await interaction.reply({ content: `Running ${textCommand}...`, ephemeral: true });

      // Route through the existing command handling as a regular message
      this.opts.onMessage(chatJid, {
        id: interaction.id,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content: textCommand,
        timestamp,
        is_from_me: false,
      });
    });

    // Handle errors gracefully
    this.client.on(Events.Error, (err) => {
      logger.error({ err: err.message }, 'Discord client error');
    });

    return new Promise<void>((resolve) => {
      this.client!.once(Events.ClientReady, async (readyClient) => {
        // Register slash commands per-guild (instant update, no 1-hour cache)
        try {
          const rest = new REST({ version: '10' }).setToken(this.botToken);
          const body = SLASH_COMMANDS.map((cmd) => cmd.toJSON());
          const appId = readyClient.user.id;

          // Clear stale global commands
          await rest.put(Routes.applicationCommands(appId), { body: [] });

          // Register per-guild for instant availability
          for (const guild of readyClient.guilds.cache.values()) {
            await rest.put(
              Routes.applicationGuildCommands(appId, guild.id),
              { body },
            );
            logger.info({ guild: guild.name }, 'Discord slash commands registered for guild');
          }
        } catch (err) {
          logger.error({ err }, 'Failed to register Discord slash commands');
        }

        logger.info(
          { username: readyClient.user.tag, id: readyClient.user.id },
          'Discord bot connected',
        );
        console.log(`\n  Discord bot: ${readyClient.user.tag}`);
        console.log(
          `  Use /chatid command or check channel IDs in Discord settings\n`,
        );
        resolve();
      });

      this.client!.login(this.botToken);
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return;
    }

    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);

      if (!channel || !('send' in channel)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        return;
      }

      const textChannel = channel as TextChannel;

      // Discord has a 2000 character limit per message — split if needed
      const MAX_LENGTH = 2000;
      if (text.length <= MAX_LENGTH) {
        await textChannel.send(text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await textChannel.send(text.slice(i, i + MAX_LENGTH));
        }
      }
      logger.info({ jid, length: text.length }, 'Discord message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message');
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isReady();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('dc:');
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
      logger.info('Discord bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client || !isTyping) return;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (channel && 'sendTyping' in channel) {
        await (channel as TextChannel).sendTyping();
      }
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Discord typing indicator');
    }
  }
}

registerChannel('discord', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['DISCORD_BOT_TOKEN']);
  const token =
    process.env.DISCORD_BOT_TOKEN || envVars.DISCORD_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Discord: DISCORD_BOT_TOKEN not set');
    return null;
  }
  return new DiscordChannel(token, opts);
});
