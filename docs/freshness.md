# Walkthrough Freshness

Walkthroughs pin `file:line` ranges. The moment the code moves, narration points
at the wrong lines. The extension tracks this; you act on it.

## How the extension tracks it

When a plan is set (or a saved one is loaded), Brix snapshots each file's content
hash, the git HEAD commit, and **anchor text** — the trimmed source line at the
start of every segment and every highlight. On each save/edit of a tracked file
it re-checks, and each segment lands in one of three states:

| State | Meaning | What happens |
|-------|---------|--------------|
| `fresh` | File unchanged, or anchors still on their recorded lines | Nothing |
| `shifted` | Anchor text found intact at a new line (edit above it) | **Auto-relocated** — segment and highlights move by the delta; a banner notes it |
| `stale` | Anchor gone, ambiguous, or highlighted lines changed | Marked ⚠ in the outline and banner; needs you |

Auto-relocation is why an edit near the top of a file doesn't destroy a
walkthrough. Only genuine changes to the narrated code go stale.

## Checking from the agent

```bash
~/.claude/skills/brix/scripts/brix.sh validate
```

Returns:

```json
{
  "overall": "fresh | shifted | stale | unknown",
  "commit": "<git HEAD when the plan was built>",
  "currentCommit": "<git HEAD now>",
  "capturedAt": 1756300000000,
  "segments": { "3": { "state": "stale", "reason": "code was edited or removed" } }
}
```

## When to check, and what to do

**Always check before resuming a walkthrough you did not just create** — the user
returning to a saved walkthrough, a question about an active one after a gap, or
any session where code was edited since the plan was built.

- `overall: "fresh"` — proceed.
- `overall: "shifted"` — proceed. Positions were already corrected; mention it only
  if the user seems confused about line numbers.
- `overall: "stale"` — do NOT narrate stale segments as if they were right. Read
  the affected files, regenerate just those segments, and send them with
  `replace_segment` (keep the same segment ids so the outline order holds):

  ```bash
  brix.sh send '{"type":"replace_segment","id":3,"segment":{...}}'
  ```

  If most segments are stale, or the change was structural, regenerate the whole
  plan instead — scout, plan, `set_plan`. Say so in one line ("the code moved
  since this walkthrough was built; regenerating three segments") rather than
  silently rebuilding.
- `overall: "unknown"` — no plan loaded, or an older saved walkthrough with no
  snapshot. Treat it as unverified: if the user is about to rely on it, regenerate.

## Review mode

Review walkthroughs go stale faster than explain walkthroughs — you are often the
one editing the code they describe. After applying any fix the user asks for
mid-review, run `validate` and regenerate affected segments before continuing.
