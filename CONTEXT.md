# brix — project context

Voice-narrated, editor-driven code walkthroughs. A coding agent builds a plan;
the VS Code extension opens files, highlights the lines being discussed, and
narrates them aloud while you follow along.

## Why this exists

Agents generate more code than a human can review. Summaries arrive as walls of
text, decisions get buried in terminal scrollback, and the result is
rubber-stamp approvals. brix attacks that with three surfaces:

1. **Walkthroughs** — importance-ordered chapters with synced highlights and
   narration, paced so you can actually read the code.
2. **Decision queue** — everything the agent is blocked on in one place, backed
   by handoff docs on disk.
3. **Distilled transcript** — findings, answers and status; process narration
   ("edited 3 files") stays in the terminal.

Two modes, one engine: **explain** existing code, and **review** a change
(diff/branch/PR). Review matters most — it interleaves chapters of the
surrounding feature with chapters of the change, because agents often write
poor changes precisely by not reading the rest of the feature, and a reviewer
can't judge a diff without the code it lands in.

## Fork provenance

Forked from [Code Explainer](https://github.com/Royal-lobster/code-explainer)
(MIT, remote `upstream`). Theirs: the extension server, highlight choreography,
Kokoro TTS pipeline, sidebar playback. Ours: review mode, decision queue,
transcript feed, theater view, freshness detection, and the rebrand. Treat
upstream as starting material, not a branch to track — no merge discipline is
maintained against it.

## Architecture

```
coding agent (Claude Code skill, no MCP)
      │  scripts/brix.sh  →  HTTP + bearer token
      ▼
VS Code extension  ── webview messages ─→  sidebar  ·  theater panels
      │                                        │
      └──────── wait-action long-poll ◄────────┘   (answers, decisions, status)
```

- **No MCP anywhere.** Skill = markdown + Bash + curl against localhost. That's
  deliberate: it works in MCP-restricted environments and with any agent that
  can run shell commands. Don't add an MCP dependency without a reason that
  can't be met by the HTTP bus.
- Connection details live in `~/.claude-brix-port` and `~/.claude-brix-token`
  (written by the extension on activation).
- The agent pushes: `set_plan`, `replace_segment`, `goto`, `raise_decision`,
  `post_update`, `watch_task`. It pulls user actions from one long-poll
  (`brix.sh wait-action`) that carries questions, decision answers, and interval
  status requests alike. Adding a new user→agent event means adding a
  `UserActionMessage` variant, not a new channel.

## Layout

| Path | What |
|------|------|
| `SKILL.md` | Agent entry point — the checklist both modes follow |
| `docs/` | Per-step instructions the skill reads on demand (`scan`, `plan`, `segments`, `review`, `walkthrough`, `handoffs`, `transcript`, `freshness`, `tts`) |
| `scripts/brix.sh` | The agent's whole API surface (curl wrapper) |
| `scripts/tts_server.py` | Kokoro TTS daemon, unix socket at `/tmp/tts-server.sock` |
| `vscode-extension/src/` | `extension.ts` (wiring), `server.ts` (HTTP/WS), `theater.ts`, `decisions-panel.ts`, `integrity.ts`, `highlight.ts`, `walkthrough.ts` |
| `vscode-extension/media/` | Webview assets; `audio-player.js` is shared by sidebar and theater |
| `design/` | UX mockup + research notes that shaped the product |

## Invariants and gotchas

These were learned the hard way — changing them tends to break something subtle.

- **An AudioContext only unlocks on a user gesture in its own document.** The
  sidebar and the theater controls each load `media/audio-player.js` and host
  their own player; `audioHost()` routes audio to whichever surface is visible.
  A single shared player would go silent whenever you press the *other* play
  button.
- **A webview cannot contain a real editor.** Theater mode is VS Code's own
  editor grid (`vscode.setEditorLayout`), not a rendered code pane, so the
  centre stays a genuine editor with real decorations.
- **Highlights point at files as they exist on disk.** Reviewing a PR means
  checking the branch out first; never plan segments against a diff the editor
  can't display.
- **Plans pin `file:line`, so they rot.** `integrity.ts` snapshots content
  hashes, git HEAD, and anchor text; pure line shifts relocate automatically,
  real edits are marked stale. Anchor relocation needs the anchor line to be
  unique in the file — a bare `}` will read as ambiguous, which fails safe.
- **Kokoro needs `misaki[en]`.** Without it `mlx_audio` imports fine but
  synthesis throws, so TTS fails silently at play time. setup.sh installs it and
  the verification step imports `misaki.en`.
- **Decisions and the feed are in-memory**, cleared on window reload. That's
  fine: handoff docs on disk are the durable record. Don't add persistence
  without a reason.
- **Model tiers are set once in SKILL.md's table** and referenced by name everywhere. `SMALL`/haiku does explain-mode discovery only; anything that writes narration or judges code (segment agents, Overview, the review scout) is `MEDIUM` or better. The review scout is deliberately not `SMALL` — spotting the call site a change *forgot* is the whole point of review mode.
- **Auto-hiding theater panels pauses playback first** — disposing the controls
  webview mid-narration would strand audio in a dead document.

## Navigator

The extension can host a second LLM — the **navigator**, a read-only
pair-programming partner (reviews diffs adversarially, answers questions about
the code on screen). The driver agent is unchanged; the navigator is
brix-controlled end to end: it explores with read-only tools (`read_file`,
`search`, `git_diff`) and must finish by calling a required `deliver` tool
whose code-anchored utterances compile into existing surfaces — `say` →
walkthrough segments (highlights + TTS), `finding` → feed, `question` →
decision cards. Walls of text are impossible by construction: there is no
free-text output channel.

Provider-agnostic via two hand-rolled fetch adapters (`src/providers.ts`):
Anthropic, and OpenAI-compatible (OpenAI, Ollama, LM Studio). Configure
`brix.navigator.provider`/`model`/`baseUrl` in settings; API key via the
"Brix: Set Navigator API Key" command (SecretStorage; Ollama/LM Studio need
none). Triggers: the sidebar ask box (falls back to the external agent's
`ask_question` long-poll action when the navigator is off) and "Brix:
Navigator — Review Working Tree Diff". `scripts/mock-openai.js` is a canned
provider for zero-cost end-to-end testing (`MOCK_BAD=1` exercises the
degrade-to-feed path).

**Questions at a step** flow through one capture-agnostic primitive:
`brix.sh ask <question>` posts an `ask` bus message that the extension routes
to the navigator (or the driver agent's `ask_question` long-poll when the
navigator is off), grounded at the current segment. Text uses the sidebar ask
box; voice uses `scripts/voice.py` — push-to-talk mic capture (ffmpeg) →
Whisper (Groq/OpenAI API, no pip deps) → `brix.sh ask`. Any other STT source
can drive the same primitive.

## Working on this

```bash
./setup.sh                      # first time: venv + TTS model + extension install
./scripts/reinstall-extension.sh   # after any extension change
# then: Cmd+Shift+P → Developer: Reload Window
```

The skill is installed as a symlink (`~/.claude/skills/brix` → this repo), so
edits to `SKILL.md` and `docs/` apply immediately; extension changes need the
reinstall + reload above.

To exercise the bus without a full walkthrough:

```bash
./scripts/brix.sh plan <plan.json>     # load a walkthrough
./scripts/brix.sh decision '{...}'     # raise a decision card
./scripts/brix.sh wait-action 60       # block for the answer
./scripts/brix.sh validate             # freshness of the loaded plan
```

## Status

Working end to end: rebrand, both walkthrough modes, decisions + handoff docs,
transcript feed with interval task watching, theater view with auto-hide,
freshness detection. macOS/Apple Silicon only (TTS). New and lightly tested:
the navigator (mock-verified; needs real provider shakeout).

Voice input now works via `scripts/voice.py` → `brix.sh ask` → navigator
(deliberately not MCP, per `design/NOTES.md`). Not built yet: a first real
`/brix review my changes` run on a substantial diff, which is the next thing
that will shake out planner-prompt bugs in `docs/review.md`.
