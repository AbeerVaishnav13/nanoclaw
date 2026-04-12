[//]: # (DO NOT DELETE — hard-won lessons. Each entry reflects at least one debugging cycle that could have been avoided.)

# Claude Agent SDK Quirks

Behaviors of `@anthropic-ai/claude-agent-sdk` that are non-obvious, undocumented, or easy to trip over. If you're about to change how we invoke `query()` or configure its `options`, read this first.

For architectural internals (how the SDK spawns CLI, the message loop, etc.), see [SDK_DEEP_DIVE.md](SDK_DEEP_DIVE.md). This doc is strictly about gotchas.

---

## `cwd` is load-bearing for more than just file resolution

The `cwd` option passed to `query()` does **two** things:

1. Defines the sandbox boundary for file edits. Any path outside `cwd` is treated as a "sensitive file" and blocked by the permission system.
2. Is the directory the SDK auto-loads `CLAUDE.md` from for system-prompt context.

**Consequence:** you cannot widen `cwd` to unlock file edits without also losing the `CLAUDE.md` auto-pickup from the narrower path.

**In NanoClaw specifically:** `cwd` must stay at `/workspace/group` so the per-group `groups/<name>/CLAUDE.md` (the agent's personality, e.g. Rocky) gets auto-loaded. To expose additional mounted directories for editing, use the `additionalDirectories` option — it extends the edit sandbox without moving the `CLAUDE.md` pickup path.

**Do not** change `cwd` to `/workspace` "to make extras editable". It silently breaks personality loading and the failure mode is subtle (the agent just stops sounding like itself). We've walked into this trap more than once.

See `container/agent-runner/src/index.ts` — the `query()` call around line 480.

---

## `.claude/` is a hardcoded sensitive path

Regardless of `cwd`, `additionalDirectories`, permission mode, or `allowDangerouslySkipPermissions`, the SDK hardcodes any path containing a `.claude/` segment as sensitive and blocks edits to it. There is no config flag to turn this off.

**Workaround:** mount the subdirectory you want to edit *directly*, so its container path doesn't contain `.claude/`. For example, to edit files under `~/Dev/claw/nanoclaw/.claude/skills/`, add that exact path to `mount-allowlist.json`. It mounts as `/workspace/extra/skills/` (basename only), and the SDK sees no `.claude/` segment in the path.

Do not try to mount a parent directory and navigate down — the `.claude/` segment in the resulting container path will trip the block.

---

## `additionalDirectories` extends edit scope but not `CLAUDE.md` auto-pickup

`additionalDirectories` widens the sandbox so the SDK permits edits to those paths, but it does **not** cause the SDK to auto-load `CLAUDE.md` files from those directories. Only `cwd`'s `CLAUDE.md` is auto-loaded.

If you need context from a `CLAUDE.md` in an additional directory, read it manually and pass it via `systemPrompt.append` (see how we handle `/workspace/global/CLAUDE.md` in `container/agent-runner/src/index.ts`).

---

## OpenRouter models need special handling in the credential proxy

`src/credential-proxy.ts` detects OpenRouter-namespaced models (containing a `/` in the model ID) and:

- Strips `anthropic-beta` and `anthropic-version` headers
- Strips `?beta=true` query param
- Converts Anthropic `thinking` body field to OpenRouter `reasoning` format
- Uses Bearer auth with `OPENROUTER_API_KEY` instead of Anthropic x-api-key

**Z.AI (and other Anthropic-compatible third-party APIs) do NOT go through this path.** They use the generic `authMode === 'bearer'` branch, which passes headers through unchanged. If you add a new third-party provider, decide consciously whether it needs its own branch or the bearer pass-through is enough — don't assume the OpenRouter logic applies.

Also, `resume`/`resumeSessionAt` options are **skipped** for OpenRouter models. They don't support session resumption the way Anthropic does, so we pass a fresh prompt every time. Same check: `isOpenRouterModel(model)`.

---

## Adding a new quirk

When you discover SDK behavior that caused a debugging cycle, add it here. Each entry should include:

1. What the behavior is
2. Why it's surprising
3. The workaround or "do this instead"
4. A pointer to the relevant code, if applicable

This doc pays itself back every time someone else avoids the trap you fell into.
