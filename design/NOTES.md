# brix — research notes & MVP direction

Named **brix**. (Earlier working name in the mockup UI: "Navigator".)
Status: forked from Code Explainer (MIT) — this repo. Rebranded, extension
compiles; SKILL.md now dual-mode (explain existing code + review changes),
see `docs/review.md`. Decision queue implemented end-to-end (2026-08-26):
handoff docs (`docs/handoffs.md` + `docs/handoff-template.md`) + sidebar
decision cards with view badge, riding the existing action bus
(`brix.sh decision` / `decisions` / `resolve-decision`, answers via
`wait-action`). Distilled transcript feed done (2026-08-26): `brix.sh post`
→ sidebar UPDATES feed (conclusions only), plus `watch-task`/`end-task` —
extension fires interval `status_request` actions for long-running work, the
agent queries the work and posts distilled status. See `docs/transcript.md`.
Voice-in plan: adopt VoiceMode (github.com/mbailey/voicemode, MIT, MCP) for
the conversational layer rather than building STT; the one wrinkle is speaker
contention — brix narration must pause while a VoiceMode exchange runs.
Mockup: `design/mockup.html`, published as the "Navigator" artifact.

## Does this exist? (researched 2026-08-26)

No single tool combines two-way voice + editor-driven, paced walkthroughs of an
agent's own changes + a decision queue + distilled output. Closest prior art:

- **Code Explainer** (github.com/Royal-lobster/code-explainer) — ~70% of the
  walkthrough half: agent skill + VS Code extension, TTS narration synced to
  gold line-highlights, play/pause/speed sidebar. But typed input only, and
  built for explaining existing code, not reviewing fresh diffs. Proves the
  agent → local extension server → WebSocket architecture works.
- **VoiceMode** (github.com/mbailey/voicemode) — full two-way voice with
  Claude Code via MCP (`converse` tool). Never touches the editor.
- **Plannotator** (plannotator.ai/code-review) — "Code Tours": reorders a
  changeset into importance-ranked chapters with narrated checkpoints;
  annotations feed back to the agent. No voice, no queue. Steal this framing.
- **Decision queues**: Omnara, octomux, gotoHuman, LangChain Agent Inbox —
  all filter by event type (needs-approval / done), never by content
  importance.
- **Signal-vs-noise distillation of agent output exists nowhere** as a
  first-class feature. That's the most open part of the idea.

## Confirmed direction

- Web dashboard (queue / transcript / narration controls) + agent drives real
  VS Code for navigation and highlights.
- Voice-out first (agent narrates; you type or use Claude Code `/voice`
  dictation). Full duplex later.
- The mockup (`index.html`) is the spec: three views — Walkthrough,
  Decisions, Transcript.

## MVP stack (when we build for real)

1. **Brain**: Claude Agent SDK (TS) with custom in-process MCP tools the
   agent calls deliberately — `show_code(file, start, end, note)`,
   `ask_decision(...)`, `pause_for_reading()`. Tool handlers forward events
   over WebSocket to the browser + editor. No parsing of prose.
2. **Editor**: day 1, reuse Claude Code's existing IDE integration — its
   WebSocket protocol (see claudecode.nvim PROTOCOL.md) already has an
   `openFile` tool with text-pattern selection. Upgrade: ~150-line VS Code
   extension with `revealRange` + `setDecorations` for real amber highlights.
3. **Browser**: static page + WebSocket fed by the MCP tool handlers
   (reference architecture: github.com/simple10/agents-observe).
4. **Voice**: macOS `say` or Web Speech TTS ($0) → Kokoro local → ElevenLabs
   Flash if quality bothers us. STT later: Chrome 139+ on-device Web Speech.
5. **Pauses**: `pause_for_reading` just awaits — tool calls block, so the
   agent naturally waits.

## Open questions to answer by using the mockup

- Is the chapter-by-importance ordering right, or should it follow data flow?
- Does the "Still reading — hold on" button carry the pacing, or does the
  agent need to infer pace (scroll position, explicit check-ins)?
- Should the transcript be the home view, with walkthrough/decisions as
  drill-ins?
- How much context does a decision card need before you can answer without
  opening the code?
