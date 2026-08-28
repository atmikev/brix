<p align="center">
  <img src="vscode-extension/media/icon.png" width="120" height="120" alt="Brix icon" />
</p>

<h1 align="center">Brix</h1>

<p align="center">
  <strong>Voice-narrated, editor-driven code walkthroughs — with a pair-programming partner built in.</strong>
</p>

<p align="center">
  A coding agent builds a plan; the VS Code extension opens the files, highlights the lines being discussed, and narrates them aloud while you follow along. Brix <strong>explains</strong> existing code and <strong>reviews</strong> a change (diff, branch, PR) in the context of the code it lands in — and hosts a second, read-only <strong>navigator</strong> LLM that reviews your diffs and answers questions about the step you're on, by voice or text.
</p>

<p align="center">
  <img src="docs/cover.png" alt="Brix cover" width="100%" />
</p>

---

> **Why this exists.** Agents generate more code than a human can review. Summaries arrive as walls of text, decisions get buried in terminal scrollback, and the result is rubber-stamp approvals. Brix attacks that with paced, importance-ordered walkthroughs that point at real code instead of describing it, a decision queue backed by handoff docs, and a distilled feed of what actually matters.
>
> See **[CONTEXT.md](CONTEXT.md)** for the architecture, invariants, and status, and **[third-party-libraries.md](third-party-libraries.md)** for attributions.

---

## ✨ What's inside

- 🎥 **Walkthroughs** — importance-ordered chapters with synced editor highlights and voice narration, paced so you can actually read the code.
- 🔍 **Two modes, one engine** — **explain** existing code, or **review** a change. Review interleaves chapters of the surrounding feature ("here's how this works today") with chapters of the change ("here's what it does to it"), because a diff can't be judged without the code it lands in.
- 🧭 **The navigator** — a brix-hosted, **read-only** pair-programming partner (any LLM) that reviews your working-tree diff adversarially and answers questions about the step you're viewing. It can't dump walls of text: its output is always code-anchored and rendered through the walkthrough, feed, and decision surfaces.
- 🎙️ **Vocal & text questions** — ask about the current step from the sidebar box or by voice (`scripts/voice.py`), transcribed **locally** with mlx-whisper — no key, nothing leaves your machine.
- 📋 **Decision queue** — everything the agent is blocked on in one place, backed by handoff docs on disk.
- 📰 **Distilled transcript** — findings, answers, and status in a feed; process narration ("edited 3 files") stays in the terminal.
- 🎬 **Theater view** — a real VS Code editor grid (not a rendered pane) with the code centre-stage, outline right, controls bottom.
- 🩺 **Freshness detection** — plans pin `file:line`, so they rot; brix snapshots content hashes and relocates pure line shifts automatically, flagging real edits as stale.
- 🔊 **Local TTS** — natural narration via Kokoro-82M through mlx-audio on Apple Silicon. Fully offline.

## 📦 Requirements

- 🍎 macOS, Apple Silicon (for GPU-accelerated local TTS/STT)
- 🐍 Python 3.10+
- 📗 Node.js 18+
- 🖥️ VS Code or Cursor with the CLI enabled (`code` or `cursor` command)

## 🔧 Installation

Tell your coding agent:

```
Install the brix skill from https://github.com/atmikev/brix
```

It clones the repo into your skills directory, runs `setup.sh`, and asks you to reload your editor.

<details>
<summary>📋 Manual installation</summary>

Clone into your agent's skills directory, then run setup:

| Agent | Clone into |
|-------|-----------|
| **Claude Code** | `~/.claude/skills/brix` |
| **Amp** | `~/.config/agents/skills/brix` |
| **OpenCode** | `~/.config/opencode/skills/brix` |
| **Codex CLI** | `~/.codex/skills/brix` |

```bash
git clone https://github.com/atmikev/brix.git <SKILLS_DIR>/brix
<SKILLS_DIR>/brix/setup.sh
# Reload your editor: Cmd+Shift+P → "Developer: Reload Window"
```

`setup.sh` creates a Python venv with the TTS + voice engines (mlx-audio, mlx-whisper, `misaki[en]`, sounddevice), builds and installs the VS Code extension, downloads the voice model, and sets script permissions. Rule-based agents (Cursor, Windsurf, Kilo, Roo, Cline) can point their rules file at the cloned `SKILL.md`.

</details>

## 💬 Usage

In your coding agent:

```
/brix the authentication system          # explain existing code
/brix review my changes                  # review the working-tree diff
```

Or naturally — "walk me through the order flow", "what did you just change?", "review this branch". Brix picks explain vs. review from the subject, asks your depth (Overview / Deep Dive) and delivery (Walkthrough / Read / Podcast), then builds the plan and starts playback.

## 🧭 The navigator

The navigator is a second LLM the extension calls **directly** — provider-agnostic, and **read-only** (it can read files, search, and diff; it cannot edit or run commands). It reviews your changes adversarially and answers questions about the code on screen. Because brix composes its whole prompt and requires structured, code-anchored output, it renders through the same walkthrough / feed / decision surfaces — no walls of text.

Configure it in VS Code settings (machine-scoped, so a workspace can't repoint it):

| Setting | Values |
|---------|--------|
| `brix.navigator.provider` | `off` (default) · `anthropic` · `openai` |
| `brix.navigator.model` | e.g. `claude-opus-5`, `qwen3:8b` |
| `brix.navigator.baseUrl` | for `openai`, e.g. `http://localhost:11434/v1` (Ollama / LM Studio) |

`openai` covers any OpenAI-compatible server, so **Ollama and LM Studio run keyless and local**. For a cloud provider, set the key with **Brix: Set Navigator API Key** (stored in SecretStorage).

- **Review** — run **Brix: Navigator — Review Working Tree Diff** from the command palette.
- **Ask** — with a walkthrough open, type in the sidebar ask box, or speak (below). Questions are grounded at the step you're viewing. If the navigator is `off`, questions fall back to your driver agent.

## 🎙️ Questions at a step (voice & text)

Both routes funnel through one primitive — `brix.sh ask <question>` — which posts the question to the current segment.

```bash
# Voice: push-to-talk, transcribed locally with mlx-whisper (no key, offline)
python3 scripts/voice.py          # Enter to record, Enter to stop

# Any source can drive the same path
./scripts/brix.sh ask "why is this guarded here?"
```

`voice.py` captures the mic with ffmpeg and transcribes with mlx-whisper (the same MLX stack as the TTS). Set `GROQ_API_KEY` / `OPENAI_API_KEY` only if you'd rather use a cloud Whisper API as a fallback.

## 🎬 Modes & controls

| Mode | Description |
|------|-------------|
| 🎥 **Walkthrough** | Highlights move through code while voice narrates in sync. Hands-free. |
| 📝 **Read** | Text explanations in the terminal, highlighting code as you go. No TTS. |
| 🎙️ **Podcast** | Renders a single audio file of the whole walkthrough. |

The sidebar has play/pause, next/prev highlight and segment, speed, volume, voice, mute, restart, save, and close. Keyboard shortcuts are active during a walkthrough:

| Shortcut | Action | | Shortcut | Action |
|----------|--------|---|----------|--------|
| `Ctrl+Shift+Space` | Play / pause | | `Ctrl+Shift+Alt+]` / `[` | Next / prev segment |
| `Ctrl+Shift+]` / `[` | Next / prev highlight | | `Ctrl+Shift+=` / `-` | Speed up / down |
| `Ctrl+Shift+\` | Stop | | | |

### 💾 Save & share

```bash
./scripts/brix.sh save auth-flow     # save the loaded walkthrough
./scripts/brix.sh load auth-flow     # replay it later
./scripts/brix.sh list               # list saved walkthroughs
```

Saved walkthroughs live in `.walkthroughs/` with relative paths, so teammates can pull and replay them.

## 🗣️ Voice configuration

Narration uses [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) via [mlx-audio](https://github.com/Blaizzy/mlx-audio); falls back to macOS `say`.

```bash
export TTS_VOICE=am_adam   # af_heart (default), af_bella, af_sarah, am_adam, am_michael, bf_emma, bm_george
export TTS_SPEED=1.2       # 20% faster
```

## 🏗️ Architecture

```
coding agent (skill: markdown + Bash + curl, no MCP)
      │  scripts/brix.sh  →  HTTP + bearer token
      ▼
VS Code extension  ── webview messages ─→  sidebar · theater panels
   │      │                                     │
   │      └── navigator (read-only LLM) ─────────┘   (reviews, answers)
   └──────── wait-action long-poll ◄───────────────  (answers, decisions, status)
```

The extension runs a token-authed HTTP + WebSocket server on localhost. The agent pushes plans, decisions, and feed updates; it pulls user actions from one long-poll. No MCP anywhere — the skill is markdown + shell + curl, so it works in MCP-restricted environments and with any agent that can run shell commands.

| Component | What |
|-----------|------|
| `server.ts` | HTTP + WS server, bearer-token auth, message validation |
| `navigator.ts` · `providers.ts` | The brix-hosted navigator + Anthropic / OpenAI-compatible adapters |
| `walkthrough.ts` · `highlight.ts` · `theater.ts` | Plan state, editor decorations, theater grid |
| `integrity.ts` | Freshness snapshots and relocation |
| `tts-bridge.ts` · `scripts/tts_server.py` | Kokoro TTS daemon over a Unix socket |
| `scripts/brix.sh` · `scripts/voice.py` | The agent's HTTP helper + local voice input |

## 📄 License

MIT — see [LICENSE](LICENSE). Third-party components and attributions are listed in [third-party-libraries.md](third-party-libraries.md).
