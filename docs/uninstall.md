# Uninstalling Brix

This guide walks you through completely removing Brix from your system. Each step includes a verification check so you can confirm the removal was successful.

---

## Step 1: Stop Running Processes

Kill the TTS server if it's running.

```bash
# Stop TTS server
if [ -f /tmp/tts-server.pid ]; then
    kill "$(cat /tmp/tts-server.pid)" 2>/dev/null
    echo "TTS server stopped"
else
    echo "TTS server not running"
fi
```

**Verify:**

```bash
# Should print "No TTS process found"
if pgrep -f tts_server.py > /dev/null; then
    echo "WARNING: TTS server still running"
else
    echo "No TTS process found"
fi
```

---

## Step 2: Uninstall the VS Code / Cursor Extension

```bash
# VS Code
code --uninstall-extension srujangurram.brix 2>/dev/null && echo "Removed from VS Code" || echo "Not installed in VS Code"

# Cursor
cursor --uninstall-extension srujangurram.brix 2>/dev/null && echo "Removed from Cursor" || echo "Not installed in Cursor"
```

**Verify:**

```bash
# Should NOT list brix
code --list-extensions 2>/dev/null | grep -i brix || echo "VS Code: clean"
cursor --list-extensions 2>/dev/null | grep -i brix || echo "Cursor: clean"
```

After uninstalling, reload your editor: **Cmd+Shift+P** → **Developer: Reload Window**

---

## Step 3: Remove the Skill Directory

This removes the skill files, Python virtual environment, and TTS model cache.

```bash
rm -rf ~/.claude/skills/brix
```

**Verify:**

```bash
[ -d ~/.claude/skills/brix ] && echo "WARNING: directory still exists" || echo "Skill directory removed"
```

---

## Step 4: Clean Up Runtime Files

Remove temporary files created during use.

```bash
rm -f ~/.claude-brix-port
rm -f ~/.claude-brix-token
rm -f /tmp/tts-server.sock
rm -f /tmp/tts-server.pid
rm -f /tmp/tts-server.log
```

**Verify:**

```bash
for f in ~/.claude-brix-port ~/.claude-brix-token /tmp/tts-server.sock /tmp/tts-server.pid /tmp/tts-server.log; do
    [ -e "$f" ] && echo "WARNING: $f still exists" || echo "$f removed"
done
```

---

## All-in-One Script

To remove everything in one go, run this from your terminal:

```bash
#!/bin/bash
set -e

echo "Uninstalling Brix..."

# 1. Stop TTS server
if [ -f /tmp/tts-server.pid ]; then
    kill "$(cat /tmp/tts-server.pid)" 2>/dev/null || true
    echo "  Stopped TTS server"
fi

# 2. Uninstall extension
code --uninstall-extension srujangurram.brix 2>/dev/null && echo "  Removed VS Code extension" || true
cursor --uninstall-extension srujangurram.brix 2>/dev/null && echo "  Removed Cursor extension" || true

# 3. Remove skill directory
rm -rf ~/.claude/skills/brix
echo "  Removed skill directory"

# 4. Clean up runtime files
rm -f ~/.claude-brix-port ~/.claude-brix-token
rm -f /tmp/tts-server.sock /tmp/tts-server.pid /tmp/tts-server.log
echo "  Cleaned up runtime files"

echo ""
echo "Done. Reload your editor: Cmd+Shift+P → 'Developer: Reload Window'"
```

---

## What Gets Removed

| Component | Location | Size |
|-----------|----------|------|
| Skill files + venv + TTS model | `~/.claude/skills/brix/` | ~500 MB |
| VS Code extension | Editor extensions directory | ~1 MB |
| Port/token files | `~/.claude-brix-port`, `~/.claude-brix-token` | <1 KB |
| TTS runtime files | `/tmp/tts-server.*` | <1 KB |
