# Human-in-the-Loop: Handoff Docs + Decision Cards

Whenever you, or a subagent you spawn, need a human (a decision, approval,
credential, PO ruling, or any blocker only a person can clear), do **not**
silently stall. Two artifacts, in this order:

1. **The handoff doc** — the durable record, in the *user's project*.
2. **The decision card** — the UI on top of it, in the Brix sidebar.

## 1. Write the handoff doc

Path: `docs/handoffs/<YYYY-MM-DD>-<slug>.md` in the user's project.

- If `docs/handoffs/TEMPLATE.md` exists in the project, copy it.
- If not, create `docs/handoffs/` and seed `TEMPLATE.md` from this skill's
  `docs/handoff-template.md`, then copy it.

Fill in: what you were doing, exactly what you need and why, the options with
your recommendation, and how to resume once answered. Surface the path in your
reply. A **subagent** that hits a human-needed blocker writes the doc and
returns its path to the orchestrator — the orchestrator raises the card.

## 2. Raise the decision card

Check the sidebar is active (same health check as SKILL.md step 0). If active:

```bash
~/.claude/skills/brix/scripts/brix.sh decision '{
  "id": "<slug>",
  "title": "<the one-line question>",
  "context": "<2-3 sentences of distilled context — not the transcript>",
  "options": [
    {"label": "<Option A>", "detail": "<tradeoff>", "recommended": true},
    {"label": "<Option B>", "detail": "<tradeoff>"}
  ],
  "handoffPath": "docs/handoffs/<YYYY-MM-DD>-<slug>.md"
}'
```

- `id` = the handoff doc slug — it's the stable key. Re-raising the same id
  updates the card instead of duplicating it.
- Keep `title` answerable: a yes/no or pick-one beats an open question.
- Mark exactly one option `recommended` when you have a recommendation
  (you usually should).

If the sidebar is NOT active, the handoff doc alone is the handoff — say so in
your reply with the path, and ask the question in chat as usual.

## 3. Wait for the answer (without stalling everything)

The user's click (or typed custom answer) arrives on the shared action bus:

```bash
~/.claude/skills/brix/scripts/brix.sh wait-action 120
# → {"type":"user_action","action":"decision_answered","decisionId":"<slug>","answer":"...","handoffPath":"..."}
```

- If you have other non-blocked work, continue it and poll between tasks
  (`wait-action` with a short timeout returns 204 when nothing is pending).
- If everything is blocked on this decision, long-poll in a loop.
- `brix.sh decisions` lists all cards and their status at any time.

## 4. Close the loop — keep handoff docs honest

The moment the decision is answered:

1. Update the handoff doc: set **Status:** ANSWERED, record the answer and
   date under a short **Resolution** heading.
2. Act on the answer, then set **Status:** RESOLVED when the unblocked work
   is done.

The moment a handoff doc becomes out of date, is completed, or contains
information that is no longer accurate, add a note at the **top** of the doc
stating that it is deprecated, the date, and why (answered, superseded by
`<path>`, situation changed, etc.). Never leave a stale handoff doc looking
current. If a card is obsolete (you resolved the blocker another way), clear
it: `brix.sh resolve-decision <id>` (no answer = withdraw) — and deprecate
the doc.
