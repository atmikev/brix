# Step 1: Scout the Codebase

Dispatch a **`SMALL`** sub-agent to discover relevant files and map the call chain. The scout does not generate highlights — it only maps the territory.

Dispatch it with `run_in_background: true` in the same response as the preference questions (SKILL.md step 0) — it runs while the user answers. Since the depth answer isn't in yet, always pass Deep Dive file targets (8-15 files); an Overview plan just uses the most important subset.

**Graphify fast path (optional dependency):** if `command -v graphify` succeeds AND `graphify-out/graph.json` exists in the project, run `graphify query "{feature} — entry point, call chain, key files"` inline (seconds, no agent) and paste the result into the scout prompt as a starting map. The scout then verifies line ranges and complexity tags instead of discovering from scratch — its slowest work is already done. (`graphify --watch` keeps the graph fresh.)

If either check fails, or the query errors, skip this silently and scout from scratch — graphify is a speed-up, never a requirement. Don't suggest installing it mid-walkthrough; the wrap-up may mention it once (see SKILL.md step 4).

Agent tool parameters:
- `subagent_type`: `Explore`
- `model`: `SMALL` ← replace with model from SKILL.md
- `description`: `Scout codebase for {feature}`

## Prompt template

```
Scout this codebase to find all files relevant to "{feature}".

1. Grep for: {feature name}, key class names, key function names
2. Glob for file patterns in relevant directories
3. Skim entry points and key files to understand the flow — signatures and the
   specific line ranges you'll report, never whole files end-to-end. You are
   drawing a map; deep reading happens later in segment generation.
4. Follow imports to discover related files

Return a structured result:

**Entry point**: the file/function where the feature starts

**Call chain**: what calls what (A → B → C → D)

**Files** (one per relevant file, in call-flow order):
  {file_absolute_path}:{start}-{end} [{complexity}]
  Role: what this file does in the feature
  Receives: what arrives from the previous file (or "entry point")
  Produces: what it hands off to the next file
  Notable: any non-obvious design decisions, patterns, or gotchas

{complexity} is one of:
  - `[core]` — central logic. Needs thorough explanation.
  - `[wiring]` — boilerplate, config, DI. Breeze through.
  - `[supporting]` — helpers, utilities, types. Explain briefly.

Depth level: {overview|deep-dive}
File count targets:
- Overview: 4-8 files
- Deep Dive: 8-15 files

Ordering: entry point first, follow data/call flow, group related logic, end with utilities/types/config.
```

Include the feature name, any files the user mentioned, and the depth level from step 0. If the user pointed to a specific file, tell the sub-agent to start there.
