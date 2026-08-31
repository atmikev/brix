# Setup (one-time)

Run the setup script — it handles everything:

```bash
~/.claude/skills/brix/setup.sh
```

This will:
1. Check prerequisites (macOS, Python 3.10+, Node.js, VS Code or Cursor)
2. Ask your model preferences — shows the default `LARGE`/`MEDIUM`/`SMALL` models and lets you swap them for any model your agent supports (GPT-4o, Gemini, local models, etc.)
3. Create a Python venv and install TTS engine (mlx-audio + sounddevice)
4. Build and install the `brix` extension (VS Code + Cursor)
5. Pre-download the TTS voice model (~330 MB)
6. Offer to install graphify (recommended add-on — precomputed knowledge graphs make scouting near-instant; decline freely, brix works without it)

After setup, reload your editor: `Cmd+Shift+P` → "Developer: Reload Window".

**Requirements:** macOS (Apple Silicon recommended), Python 3.10+, Node.js, VS Code or Cursor with CLI enabled.

**Optional:** [graphify](https://pypi.org/project/graphifyy/) (`uv tool install graphifyy`). Run `graphify .` in a repo once and brix seeds its scout from the precomputed knowledge graph instead of exploring cold — scouting drops from minutes to seconds. Brix works fully without it.
