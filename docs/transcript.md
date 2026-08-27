# Distilled Transcript: Post What Matters, Watch What Runs

The sidebar feed shows the user only what they'd act on — findings, answers,
status of long work — while process narration ("edited 3 files", "running
tests") stays in the terminal. Two mechanisms:

## 1. Post distilled updates

When you produce something the user would actually read — a finding, an
answer, a completed-work summary — post it:

```bash
~/.claude/skills/brix/scripts/brix.sh post '{
  "kind": "finding",
  "title": "apiClient retries 429s instantly — will fight the limiter",
  "body": "src/lib/apiClient.ts:88 treats 429 like a transient 5xx and ignores Retry-After.",
  "source": "review scout"
}'
```

Kinds: `finding` (something discovered that the user should know), `answer`
(the result of what they asked for), `status` (progress of long-running work),
`progress` (minor milestone; rendered de-emphasized), `info` (anything else).

Rules of distillation:
- `title` is one sentence a person can act on. `body` is 1-3 sentences max.
- Post the conclusion, never the process. "Found the race in session refresh"
  — not "Read 14 files and ran grep".
- One post per meaningful event. If you're posting more than ~1 per minute,
  you're posting process.
- Posting does NOT replace your normal chat reply — the feed is a glanceable
  surface, not the conversation.

## 2. Watch long-running work (interval status updates)

When you kick off work that will run for a while — background subagents, a
long migration, a batch job — register it so the sidebar keeps the user
informed without them asking:

```bash
brix.sh watch-task migration-sweep "Migrating 214 call sites" 300
```

While a task is watched, the extension enqueues a `status_request` action
every interval (default 300s, min 60s) — deduped, so at most one per task
waits for you. Your loop:

1. Start the long work (background subagents, etc.), then `watch-task`.
2. Between steps — or while blocked waiting on the work — poll:
   `brix.sh wait-action 60`
3. On `{"action":"status_request","taskId":...}`: **query the running work
   for its current state** (check the subagent's latest output, read its
   progress file or logs, ask the model for a one-line status). Summarize to
   1-2 sentences and post it:
   `brix.sh post '{"kind":"status","title":"Migration: 130/214 call sites done","body":"No conflicts so far; ETA ~6 min.","source":"task:migration-sweep"}'`
4. When the work finishes: `brix.sh end-task migration-sweep "All 214 call
   sites migrated, suite green."` — this stops the interval and posts the
   completion to the feed. Then post an `answer` item with the real summary
   if the task was the user's main ask.

Notes:
- `wait-action` is a shared bus: you may receive `ask_question`,
  `decision_answered`, or `status_request` — handle whichever arrives.
- If the underlying work dies, `end-task` with a summary saying so — never
  leave a watched task running forever.
- A `status_request` you can't answer meaningfully yet ("still starting up")
  deserves a short honest status, not silence.
