---
name: brix
description: "Use when the user asks to explain, walk through, or understand code — OR to walk through, review, or understand a change, diff, branch, or PR. Triggers on 'explain', 'walk me through', 'how does X work', 'what does this code do', 'review this change', 'walk me through the diff', 'what did you change', 'brix'."
---

# Brix

Interactive code walkthroughs with editor highlighting and voice narration. Two modes, one engine:

- **Explain** — understand existing code: a feature, module, or flow.
- **Review** — understand a change: a diff, branch, or PR, *in the context of the code around it*. Review walkthroughs interleave chapters of the surrounding feature ("here's how this works today") with chapters of the change ("here's what the change does to it"), because a change can't be judged without the code it lands in.

## Models

Configure your preferred models here. All docs reference these tiers by name — change them once and the whole skill updates.

| Tier | Default | Role |
|------|---------|------|
| `LARGE` | `opus` | Deep Dive planner — narrative reasoning, transition objects |
| `MEDIUM` | `sonnet` | Segment agents, Overview plan+highlights, review scout — anything writing narration or judging code |
| `SMALL` | `haiku` | Explain-mode scout — fast discovery and scanning, no judgment calls |

When dispatching sub-agents, look up the model for the tier and use that exact model name.

## Checklist

Complete these steps in order:

0. **Pick the mode** — Review mode when the subject is a change: a diff, uncommitted work, a branch, a PR, or "what you just did". Explain mode when the subject is existing code. If genuinely ambiguous ("walk me through auth" right after auth changes landed), ask. Then dispatch both of these in a **single response**:
   - **Sidebar check (Bash):** `PORT=$(cat ~/.claude-brix-port 2>/dev/null) && TOKEN=$(cat ~/.claude-brix-token 2>/dev/null) && curl -sf -H "Authorization: Bearer $TOKEN" "http://localhost:$PORT/api/health"` — `{"status":"ok"}` means sidebar is active. When active, **NEVER output walkthrough content as terminal text**; all output goes through sidebar HTTP API only.
   - **Ask preferences (AskUserQuestion):** Explain mode: read `docs/assess.md` and ask all three questions listed there in a single call. Review mode: read `docs/review.md` and ask its two questions instead.

1. **Scout** — Explain mode: read `docs/scan.md` and dispatch a `SMALL` sub-agent to discover relevant files and map the call chain. Review mode: read `docs/review.md` — resolve the changeset first, then dispatch the review scout as a `MEDIUM` sub-agent (it maps the diff AND the surrounding feature code, and judges what the change missed). No highlights yet — discovery only.
2. **Plan + generate** — Two paths depending on depth:
   - **Overview / Quick review** — Single `MEDIUM` sub-agent reads scout output, builds plan, generates highlights in one pass. Its segment 1 must be a SHORT orientation segment (big picture + route ahead, 4 short sentences max, 1-2 highlights, no detail) — pass that requirement verbatim in the sub-agent prompt. Review mode: also follow the chapter-ordering rules in `docs/review.md`. Send `set_plan` when done.
   - **Deep Dive / Thorough review** — Read `docs/plan.md` (and `docs/review.md` for review-mode ordering rules). Dispatch `LARGE` planner to build narrative + transition objects. Then read `docs/segments.md` and dispatch parallel `MEDIUM` segment agents (all at once). Create a unique temp dir with `mktemp -d` and have each agent write its segment there. Wait for ALL agents to complete, then assemble from files with `jq` and send one full `set_plan`. Clean up the temp dir after sending. Do NOT send anything to the sidebar until everything is ready.
3. **Execute walkthrough** — Read the doc for chosen mode: `docs/walkthrough.md`, `docs/read.md`, or `docs/podcast.md`. Walkthrough and podcast reference `docs/tts.md`.
4. **Wrap up** — Explain mode: 3-5 key takeaways, how the feature fits the broader architecture, offer to dive deeper or explain related features. Review mode: the fit-check verdict from `docs/review.md` (does the change fit the surrounding code? missed call sites? convention drift?), then any decisions the user still owes.

**First-time setup?** Read `docs/setup.md`.

## Distilled Transcript + Long-Task Watching

The sidebar has an UPDATES feed for what the user would actually read — findings, answers, long-task status — while process narration stays in the terminal. Read `docs/transcript.md` and follow it: post conclusions with `brix.sh post '{...}'`; when starting long-running work, register it with `brix.sh watch-task <id> <title> [interval_sec]` — the extension then requests a status update on an interval via the `wait-action` bus, and you answer each request by querying the running work and posting a 1-2 sentence distilled status. `brix.sh end-task <id> [summary]` when it finishes.

## Walkthrough Freshness

Walkthroughs pin `file:line` ranges, so edits can point narration at the wrong code. Before resuming any walkthrough you did not just create — a saved one, an active one after code changed, a review whose fixes you just applied — run `~/.claude/skills/brix/scripts/brix.sh validate` and read `docs/freshness.md`. Pure line shifts are auto-corrected by the extension; `stale` segments must be regenerated with `replace_segment` (or the whole plan re-planned) before you narrate them.

## Human-in-the-Loop → Handoff Doc + Decision Card

Whenever you, or a subagent you spawn, need a human (a decision, approval, credential, or any blocker only a person can clear), do **not** silently stall — read `docs/handoffs.md` and follow it: write a handoff doc at `docs/handoffs/<YYYY-MM-DD>-<slug>.md` in the user's project (seed `TEMPLATE.md` from this skill's `docs/handoff-template.md` if missing), then raise a decision card in the sidebar with `brix.sh decision '{...}'` and collect the answer via `brix.sh wait-action`. A subagent writes the doc and returns its path; the orchestrator raises the card. Keep handoff docs honest: deprecate them at the top the moment they go stale. This applies during walkthroughs AND during any other brix-adjacent work.

## Q&A on Active Walkthrough

When the user says they're in an active brix walkthrough and asks a question (even in a new chat), skip the full checklist above and instead:

1. **Get context:** Run `~/.claude/skills/brix/scripts/brix.sh state` — the response now includes a `segment` field with the full current segment (`file`, `start`, `end`, `title`, `explanation`, `highlights`). Use this to understand what code the user is currently viewing.
2. **Read the code:** Use the segment's `file`, `start`, and `end` to read the relevant source code.
3. **Answer in context:** Ground your answer in the specific code and segment the user is looking at. Reference line numbers from the segment, not abstract concepts.

If `state` returns `status: "idle"` (no active walkthrough), check `.walkthroughs/` for saved plans and ask the user which one they mean.

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Scope too large | Stick to segment boundaries. Overview: max 80 lines, Deep Dive: max 40. Split if bigger |
| Not connecting segments | Include a context line linking to previous segment |
| Forgetting to highlight | Sidebar: automatic. Fallback: write to `~/.claude-brix-highlight.json` |
| Reading entire file | Use offset+limit on Read for just the segment |
| Not waiting for user | Pause after each segment for questions |
| ttsText missing or has markdown | Include plain `ttsText` in every segment — strip backticks, bold, line refs from spoken text |
| Explaining obvious code, missing the "why" | Skip standard patterns (loops, imports, null checks). Always explain intent before mechanism |
| Ignoring complexity tags | `[core]` = thorough, `[wiring]` = breeze through, `[supporting]` = brief |
| Sidebar check not parallelized | Dispatch Bash health check + AskUserQuestion in one response, not sequentially |
| Text output when sidebar active | If health check returned ok, send plan JSON only — no terminal text |
| Sub-highlights too many or too granular | Deep Dive: 6-12 highlights per segment, 1-4 lines each. Highlights are a moving pointer over one continuous voice stream — ttsText across highlights is concatenated and spoken as one TTS call, so write it as flowing narration, not self-contained slides. Overview: 1-8 lines, 3-6 per segment |
| Wrong field names in sidebar JSON | Use `start`/`end`/`title`/`ttsText`/`highlights` — NOT `startLine`/`endLine`/`label`/`subHighlights`. See `docs/plan.md` for exact schema |
| Skipping `set_plan` before `goto` | Sidebar needs the full plan loaded first. Always send `set_plan` via `brix.sh plan` before any `goto` messages |
| Sending plan before agents finish | Wait for ALL parallel segment agents to complete. Each writes to a unique temp dir (created via `mktemp -d`). Assemble from files with `jq`, then send one `set_plan`. Clean up temp dir after. Never send stubs or partial plans |
| Scout generating highlights | Scout only maps files and call chain. Highlights are generated in step 2 (Overview: single agent, Deep Dive: parallel agents) |
| Running planner + parallel agents for Overview | Overview uses one `MEDIUM` agent for plan + highlights. Planner and segment agents are Deep Dive only |
| Review scout on `SMALL` | The review scout hunts untouched call sites and convention breaks — the pipeline's hardest judgment. It is `MEDIUM`, unlike the explain-mode scout |
| Using tier names as literal model names | `LARGE`, `MEDIUM`, `SMALL` are placeholders — always resolve to the actual model name from the Models table in SKILL.md before dispatching |
| Diving into details cold | Segment 1 of EVERY walkthrough (both modes, both depths) is an orientation segment: the big picture and the route ahead. Hard cap: **4 short sentences**, 1-2 highlights, no line-by-line yet. See `docs/plan.md` / `docs/review.md` |
| Orientation that rambles | 4 short sentences is a ceiling, not a target. No history, no caveats, no feature tour — just what it is and where we're going |
| Review: walking the diff in file order | Order chapters by importance — heart of the change first, then consequences, then glue/tests. See `docs/review.md` |
| Review: showing only changed lines | Interleave context segments of the surrounding, unchanged code the change plugs into. The diff alone can't tell the user whether the change fits |
| Narrating a stale walkthrough | Run `brix.sh validate` before resuming any plan you didn't just build. Regenerate `stale` segments with `replace_segment` — never narrate lines the check flagged. See `docs/freshness.md` |
| Regenerating silently | Say in one line that the code moved and what you're regenerating, then do it |
| Review: highlighting a file state that isn't on disk | Highlights point at files as they exist on disk. Reviewing a PR? Check out the branch first (`gh pr checkout`). Never plan segments against a diff the editor can't display |
| Stalling silently on a human decision | Write the handoff doc, raise the decision card (`brix.sh decision`), keep working on unblocked tasks while polling `wait-action`. See `docs/handoffs.md` |
| Decision card without a handoff doc | The card is UI; the doc is the durable record. Always write the doc first and pass its path as `handoffPath` |
| Asking open-ended questions in decision cards | Options with one `recommended: true` beat an essay question. Custom text input exists for the user's escape hatch, not as your default |
| Posting process narration to the feed | The feed is conclusions only — findings, answers, status. "Edited 3 files" stays in the terminal. See `docs/transcript.md` |
| Long work with no watch-task | Register long-running work with `watch-task` so the user gets interval status updates instead of silence; `end-task` when done — never leave a watch running forever |
| Answering status_request with raw output | Query the running work, then distill to 1-2 sentences before posting. The feed is a glance, not a log |
