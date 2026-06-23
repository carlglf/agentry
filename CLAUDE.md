# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-app repo. **Agent Console** (`agent-console/`) is a local web console that drives multiple CLI coding agents (Codex, Claude) as real PTY sessions. The UI is a three-column console — left project/Agent tree, center chat debugger, right live terminal — backed by a Node server that spawns a PTY per Agent and bridges it to the browser over WebSocket. The chat panel is a *facade* over the terminal: sending a chat message types into the PTY, and the agent's terminal output is captured, cleaned of TUI chrome, and rendered back as a chat reply.

UI copy and seed data are in Chinese; keep that convention when editing.

## Commands

All commands run from `agent-console/`:

```bash
npm install            # uses .npmrc → caches into ./.npm-cache (not ~/.npm)
npm run dev            # Vite middleware-mode dev server + PTY backend on http://127.0.0.1:5173
npm run build          # vite build → dist/
npm start              # NODE_ENV=production node server.mjs (serves dist/)
npm test               # vitest run — unit/integration tests for the discussion-group server modules
npx acg serve          # same as `npm start`; the packaged CLI entry (bin: acg)
npx tsc --noEmit       # typecheck (no linter)
```

Tests cover the **discussion-group** server modules only (pure logic + mocked-PTY API flow under `test/`); the React UI and the legacy TTY-capture path have **no tests**. `server.mjs` is the entry for both dev and prod — Vite runs in middleware mode inside it (not the standalone `vite` CLI), so `npm run dev` is what boots the full app including the WebSocket/PTY backend. To verify a change, run the dev server and open the in-app browser preview rather than handing the user start instructions (see `agent-console/AGENTS.md`).

## Architecture

Two files hold essentially everything:

- **`agent-console/server.mjs`** — Node HTTP + WebSocket server. No framework. Three concerns:
  - **Runtime registry** (`runtimeMeta`): per-runtime command/model metadata for `codex` and `claude`. `buildCommandPreview()` turns an Agent config into the actual shell command (honoring a custom `startCommand` or falling back to `<command> <yoloArgs> --model <model>`).
  - **REST API** under `/api/`: `GET /api/runtime-meta`, `POST /api/agents/:id/runtime` (stores the config in the in-memory `runtimeConfigs` map — must be called before opening the socket), `POST /api/agents/:id/input`, `POST /api/agents/:id/stop`.
  - **PTY sessions** (`sessions` map): `startPtySession` spawns the user's shell with `node-pty` running the agent command, then drops to an interactive login shell so the session survives the command exiting. Output is mirrored to a per-session `transcript` (capped at `MAX_TRANSCRIPT_CHARS`) so reconnecting clients replay scrollback. Multiple WebSocket clients can attach to one session.
- **`agent-console/src/App.tsx`** — the entire React UI in one ~2600-line file. Key pieces:
  - **Zustand store** (`useConsoleStore`) with `persist` middleware → `localStorage` key `agent-console-mvp`. **All state is browser-local**; there is no server-side database. The store holds projects, agents, commands, messages, terminalLogs and selection state. Bumping the persisted shape requires incrementing `version` and updating `migrate` (currently v5).
  - **`TerminalPanel`** owns the xterm.js terminal, the WebSocket, and the **TTY capture state machine** — the trickiest part of the codebase.
  - **`ChatPanel`** sends through a `TtyBridge` (registered by `TerminalPanel` via `onBridgeChange`); replies arrive through `onTtyResponse`.

### The chat ↔ TTY bridge (the part to understand before touching capture)

When a chat message is sent, `TtyBridge.send` opens a `captureRef` capture window, types the message into the PTY via `buildTtyInputSequence` (handles runtime-specific submit keystrokes/delays), then accumulates all subsequent socket output into `capture.chunks`. A debounced state machine (`scheduleCaptureFlush` / `flushCapturedOutput`, tuned by the `CAPTURE_*` constants) decides when the agent has finished responding using `isAgentReadyForInput` / `isAgentReadyAfterPrompt`, then runs `cleanTtyOutput` to strip ANSI, TUI frames, prompt echoes, thinking lines, and status chrome before emitting one chat message + terminal log.

The cleaning logic is **runtime-specific and heuristic** — there are parallel `extractCodexAssistantText` / `extractClaudeAssistantText` families plus many `is*TuiLine` / `is*ConversationBoundary` / `strip*Chrome` helpers keyed on Codex vs Claude TUI quirks. When an agent's output renders wrong in chat, the fix is almost always in these helpers, and changes to one runtime's path should not touch the other's.

### Discussion groups (the second feature, in `server/` + `bin/`)

A **discussion group** is a reusable roster of N members (each with runtime/model/persona/duty, exactly one host) that runs multi-turn, multi-agent discussions on a **topic** (a `DiscussionSession`). Each session spawns one PTY per member; members take turns via a CLI (`acg say --next <name> "..."`, host `acg end "..."`). Requirements/decisions: `讨论组功能需求文档.md`. Key contrasts with the agent path:

- **Explicit content, not capture.** Members submit their message text via the CLI, so this path **completely bypasses** `cleanTtyOutput`/`extract*` — the CLI call also doubles as the reliable turn-end signal. Don't reuse the capture state machine here.
- **Server-side JSON persistence** (`server/discussion-store.mjs` → `.data/discussions.json`, gitignored). Unlike the all-browser-local agent state, discussion groups/sessions/messages live on the server; the frontend reads them via REST (`useDiscussionStore` in `App.tsx`, **not** zustand-persisted) and polls the active session.
- **Logic is extracted into pure modules so it's testable**: `server/discussion-engine.mjs` (validation, `computeDelta` incremental-context, `reduceSay`/`reduceEnd` state machine — round counts **per speaking turn**), `server/prompt-builder.mjs`, `server/cli-args.mjs`. `server/discussion-pty.mjs` is the only PTY-touching module (injected `spawn` for tests); `server/discussion-routes.mjs` wires it all into `handleApi`. Member PTY sessions are keyed `disc:<sessionId>:member:<memberId>` (separate from the agent `sessions` map); the WS upgrade handler routes `disc:`-prefixed ids to `ptyMgr.attachClient`.
- **Context sync (token-optimal):** only "others-only, since-my-last-turn" messages are injected into the next speaker (`computeDelta`), relying on each agent's own PTY memory.

## Conventions

- **Adding a runtime or model**: update `runtimeMeta` in `server.mjs` **and** `agentRuntimeOptions` + `defaultStartCommand` in `App.tsx` — they are duplicated and must stay in sync. Output-cleaning for a new runtime means a new `extract*`/`is*TuiLine` family.
- Agents launch in **YOLO/bypass-permissions mode** by design (`--yolo`, `--dangerously-skip-permissions`); the server sets `AGENT_CONSOLE_YOLO=1`. `normalizeStartCommand` rewrites older default command strings on load.
- `dist/` is committed and served in production — rebuild it when shipping UI changes.
- `style.png` (repo root) is the visual source of truth; `agent-console/design-qa.md` records QA against it. Per `AGENTS.md`, record durable design decisions there.
