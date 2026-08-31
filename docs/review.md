# Review Mode: Walking Through a Change

Review mode turns a diff into a guided walkthrough — the change **and** the existing code it lands in. The goal is that the user finishes understanding not just *what* changed, but whether the change *fits*: the surrounding feature's conventions, its call sites, its assumptions.

This doc covers the review-mode replacements for steps 0-2. Steps 3-4 (execution, wrap-up) are shared with explain mode.

## Step 0b: Preferences (replaces `docs/assess.md`)

Ask EXACTLY these two questions using AskUserQuestion (both in one call):

### Question 1: Review depth

"How thorough should this review walkthrough be?"

| Option | Description |
|--------|-------------|
| **Quick review** | The heart of the change + anything risky. 3-6 chapters, glue and tests summarized in one breath. |
| **Thorough review** | Every meaningful hunk plus the surrounding code it touches. 6-15 chapters. |

### Question 2: Delivery mode

"How would you like the walkthrough delivered?"

| Option | Description |
|--------|-------------|
| **Walkthrough** (recommended) | Auto-advancing highlights + TTS narration via sidebar. Hands-free. |
| **Read** | Text explanations in terminal. No sidebar or TTS required. |
| **Podcast** | Single audio file of entire walkthrough. |

(No familiarity question — the diff defines the territory. If the user volunteers familiarity context, use it.)

## Step 1: Resolve the changeset, then scout

Both parts happen in the same response as the preference questions (SKILL.md step 0): resolve the changeset inline, then dispatch the scout with `run_in_background: true` so it runs while the user answers. The scout doesn't use the answers.

**Graphify fast path (optional dependency):** if `command -v graphify` succeeds AND `graphify-out/graph.json` exists, run `graphify query "callers and callees of {changed symbols}"` inline and paste the result into the scout prompt — caller/callee mapping is the scout's slowest step, and the graph precomputes it. The scout then spends its time on the judgment calls (missed call sites, convention fit) instead of grep archaeology. If either check fails, or the query errors, skip silently and scout from scratch.

### Resolve the changeset (inline, before dispatching the scout)

Figure out what "the change" is and make sure it exists **on disk** — highlights point at files as they exist in the editor, so the post-change file state must be checked out:

| Subject | Diff command | On-disk requirement |
|---------|--------------|---------------------|
| Uncommitted work | `git diff HEAD` (+ `git status` for untracked files) | Already on disk |
| A branch | `git diff $(git merge-base main HEAD)..HEAD` | Check the branch out if not current |
| A PR | `gh pr diff <n>` | `gh pr checkout <n>` first |
| "What you just did" | The edits from this session | Already on disk |

If checking out would clobber uncommitted work, stop and ask.

### Dispatch the review scout

Dispatch a **`MEDIUM`** sub-agent — not `SMALL`. This scout does the hardest reasoning in the pipeline: spotting call sites the change *didn't* update and judging whether it breaks surrounding conventions. Finding the diff is easy; noticing what's suspiciously absent is not. It maps the diff AND the feature code around it — no highlights, discovery only.

Agent tool parameters:
- `subagent_type`: `Explore`
- `model`: `MEDIUM` ← replace with model from SKILL.md
- `description`: `Scout changeset and surrounding code`

#### Prompt template

```
Scout this changeset and the code surrounding it.

The diff (summary):
{diff_stat_and_hunks_or_path_to_diff_file}

1. For each changed file, read the enclosing functions/classes of every hunk —
   not just the changed lines. Read only those enclosing ranges, never whole
   files — you are mapping, not reviewing line-by-line.
2. Map the neighborhood: for each significant changed symbol, find its callers
   and callees (grep for the symbol name). Note call sites the change did NOT
   touch — these are missed-update candidates.
3. Identify the existing conventions in the surrounding code (error handling
   style, naming, how similar features are structured) and note where the
   change follows or breaks them.

Return a structured result:

**The heart of the change**: 1-2 sentences — the essential idea, and which file/lines embody it

**Changed files** (one per file, most important first):
  {file_absolute_path} [{importance}]
  Hunks: {line ranges of changes}
  Role: what this file's change does
  Context needed: {existing file:lines the user must see to judge this change, or "none"}
  Fit: follows/breaks surrounding conventions — how

**Untouched call sites**: places that call changed code but were not updated
  (file:line — why it might or might not need updating)

**Risks**: anything that looks incomplete, inconsistent with the surrounding
  feature, or worth the user's judgment

{importance} is one of:
  - `[heart]` — the essential change. The walkthrough opens here.
  - `[consequence]` — follows from the heart (call-site updates, propagated types)
  - `[glue]` — config, wiring, lockfiles, generated code. One breath.
  - `[tests]` — test changes. Show the one test that proves the change works.
```

## Step 2: Plan — chapter ordering rules

These rules apply to whichever planning path runs (single `MEDIUM` agent for Quick review, `LARGE` planner + `MEDIUM` segment agents for Thorough — same dispatch mechanics as explain mode, see `docs/plan.md` and `docs/segments.md`).

1. **Open with a short orientation segment.** Segment 1 anchors on the heart of the change: what it does and the route ahead. **4 short sentences maximum** (~20 seconds spoken), 1-2 highlights, no detail yet. Cut anything that isn't the map.
2. **Order by importance, not file order or diff order.** Heart first, then consequences, then tests, then glue. The user should be able to stop after chapter 3 and have understood the change.
3. **Interleave context segments.** Before a change segment the user can't judge cold, insert a segment over the *existing, unchanged* code it plugs into ("Context needed" from the scout). Narrate context segments as "here's how this works today and what matters about it"; narrate change segments as "here's what the change does to it, and why". Same segment schema — `file`/`start`/`end`/`title`/`ttsText`/`highlights` — the sidebar doesn't distinguish. Prefix context segment titles with `Context: `.
4. **Consolidate glue.** All `[glue]` files share one closing segment, or are skipped with a one-line mention in the wrap-up. Never one chapter per lockfile.
5. **Carry the scout's risks into the narration.** An untouched call site or convention break belongs in the ttsText of the chapter where the user is looking at the relevant code — not saved for the end. The wrap-up repeats them as a checklist.
6. **Segment sizes** match explain mode: Quick review like Overview (40-80 lines, 1-8 line highlights), Thorough like Deep Dive (15-40 lines, 6-12 highlights of 1-4 lines).

Show the plan outline in chat (Thorough review), same as explain mode — and dispatch the segment agents in the background in that same response, so generation overlaps the approval pause (see `docs/plan.md`). The user can still reorder, skip, or add; regenerate only the affected segments.

## Step 4 addendum: the fit-check wrap-up

End every review walkthrough with:

1. **Verdict on fit** — does the change match how the surrounding feature works? Name specifics, not vibes.
2. **Open risks** — untouched call sites, convention breaks, anything the scout flagged that narration touched. Formatted as a short checklist the user can act on.
3. **Decisions owed** — anything you need from the user before this change should ship.
