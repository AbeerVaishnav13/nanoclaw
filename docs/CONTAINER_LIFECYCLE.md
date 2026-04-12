# Container Lifecycle — Log Markers and States

How to tell, from `logs/nanoclaw.log` alone, what an agent container is doing right now. This is the contract the macOS statusbar, `/debug`, and any future external observers rely on.

If you're adding a new lifecycle state or changing how containers are spawned, update this doc **and** the statusbar skill's state-detection logic together.

## States

A container (per chat group) is in exactly one of these states at any moment:

| State              | Meaning                                                  | Statusbar indicator |
|--------------------|----------------------------------------------------------|---------------------|
| **stopped**        | NanoClaw service itself is not running                   | red `stop.fill`     |
| **noContainer**    | Service running, but no agent container is alive         | blue `pause.fill`   |
| **containerIdle**  | Container alive, finished responding, waiting for input  | green `play.fill`   |
| **containerActive**| Container alive, actively processing a message           | orange spinner      |

## Log markers

Lifecycle-relevant log events are emitted at `info` level or above. This is a **public interface** — debug-level events can be dropped or reordered freely, but the markers below are contract.

| Marker                                  | Emitted when                                              | State implication                 |
|-----------------------------------------|-----------------------------------------------------------|-----------------------------------|
| `Spawning container agent`              | A fresh container is being started for a message          | transitions to `containerActive`  |
| `Piped messages to active container`    | A follow-up message was sent via IPC to an existing container (no new spawn) | transitions to `containerActive`  |
| `Agent output:`                         | The agent emitted a response                              | transitions to `containerIdle`    |
| `Container completed`                   | The container process exited                              | transitions to `noContainer`      |

## Detection algorithm

To compute the current state by tailing the log:

1. If `launchctl list com.nanoclaw` does not return a live PID → **stopped**.
2. If `docker ps --filter name=nanoclaw-` returns no container → **noContainer**.
3. Read the last ~8 KB of `logs/nanoclaw.log`. Find the most recent occurrence of each marker.
4. Pick the latest "work started" marker — `Spawning container agent` or `Piped messages to active container`, whichever is more recent. If neither exists, the agent has no pending work → **containerIdle**.
5. If `Agent output:` appears *after* the latest work marker → **containerIdle** (responded, now waiting).
6. Otherwise → **containerActive** (work started, no output yet).

The reference implementation lives in `.claude/skills/add-macos-statusbar/add/src/statusbar.swift` (`checkRecentActivity` and `checkState`).

## Why both "Spawning" and "Piped messages" count as work-started

Containers stay alive for a short window after responding, to amortize startup cost on follow-up messages in the same conversation. Follow-up messages are delivered via IPC to the running container — there is no new spawn event for them. Without the `Piped messages to active container` marker, the statusbar would miss every follow-up and stay green even while the agent is working.

## Rules for adding new markers

- Emit at `info` level or above. `debug` is for development noise and may be filtered.
- Use the exact wording listed above — do not rename or reformat. External observers grep literally.
- If you add a new lifecycle event, add a row to the tables above AND update the reference state machine in `statusbar.swift`. The two must move together.
- Include structured fields (e.g. `{ chatJid, count }`) as a second argument — pino serializes them into the log line without affecting grep-ability of the message text.
