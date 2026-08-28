#!/usr/bin/env python3
"""Voice questions for brix — push-to-talk mic → Whisper → brix.sh ask.

Speak a question about the step you're viewing; it's transcribed and routed to
the navigator (or your coding agent) grounded at the current walkthrough step.

Usage:
    voice.py                 # push-to-talk loop: Enter to record, Enter to stop
    voice.py --once          # record one question and exit
    voice.py --selftest      # exercise key loading + transcript cleanup, no mic

Audio capture uses ffmpeg (avfoundation); transcription uses the Groq or OpenAI
Whisper API. Set GROQ_API_KEY (preferred) or OPENAI_API_KEY in the environment,
or in ~/.config/brix/.env or ~/.config/watch/.env (KEY=value lines). Override
the mic with BRIX_AUDIO_DEVICE (default ":0") or force fixed-length capture with
BRIX_RECORD_SECONDS.
"""

import os
import subprocess
import sys
import tempfile

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BRIX = os.path.join(SCRIPT_DIR, "brix.sh")
AUDIO_DEVICE = os.environ.get("BRIX_AUDIO_DEVICE", ":0")

PROVIDERS = {
    "GROQ_API_KEY": ("https://api.groq.com/openai/v1/audio/transcriptions", "whisper-large-v3"),
    "OPENAI_API_KEY": ("https://api.openai.com/v1/audio/transcriptions", "whisper-1"),
}


def load_key():
    """Return (env_name, key) from the environment or a known .env file."""
    envs = dict(os.environ)
    for path in (os.path.expanduser("~/.config/brix/.env"), os.path.expanduser("~/.config/watch/.env")):
        try:
            with open(path) as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith("#") and "=" in line:
                        k, v = line.split("=", 1)
                        envs.setdefault(k.strip(), v.strip().strip('"').strip("'"))
        except OSError:
            pass
    for name in PROVIDERS:
        if envs.get(name):
            return name, envs[name]
    return None, None


def record(path, seconds=None):
    """Capture mic audio to a wav. Fixed length if seconds given, else Enter-to-stop."""
    args = ["ffmpeg", "-y", "-f", "avfoundation", "-i", AUDIO_DEVICE, "-ac", "1", "-ar", "16000"]
    if seconds:
        args += ["-t", str(seconds)]
    args.append(path)
    if seconds:
        subprocess.run(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        return
    proc = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        input("  recording… press Enter to stop ")
    finally:
        try:
            proc.communicate(input=b"q", timeout=3)
        except Exception:
            proc.terminate()


def transcribe(path, env_name, key):
    """POST the wav to the Whisper API via curl; return the transcript text."""
    url, model = PROVIDERS[env_name]
    out = subprocess.run(
        ["curl", "-sS", url, "-H", f"Authorization: Bearer {key}",
         "-F", f"file=@{path}", "-F", f"model={model}", "-F", "response_format=text"],
        capture_output=True, text=True,
    )
    return clean(out.stdout)


def clean(text):
    """Whisper sometimes returns a trailing newline or leading space."""
    return (text or "").strip()


def ask(question):
    subprocess.run([BRIX, "ask", question], check=False)


def one_shot(env_name, key):
    seconds = os.environ.get("BRIX_RECORD_SECONDS")
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        wav = tmp.name
    try:
        record(wav, int(seconds) if seconds else None)
        question = transcribe(wav, env_name, key)
    finally:
        try:
            os.unlink(wav)
        except OSError:
            pass
    if not question:
        print("  (nothing transcribed)")
        return
    print(f"  → {question}")
    ask(question)


def selftest():
    assert clean("  hi there \n") == "hi there"
    assert clean(None) == "" and clean("") == ""
    name, key = load_key()
    print(f"key source: {name or 'NONE (set GROQ_API_KEY or OPENAI_API_KEY)'}")
    print(f"brix.sh:    {'found' if os.path.exists(BRIX) else 'MISSING'} at {BRIX}")
    print("selftest OK")


def main():
    if "--selftest" in sys.argv:
        selftest()
        return
    env_name, key = load_key()
    if not key:
        sys.exit("No API key. Set GROQ_API_KEY or OPENAI_API_KEY (env or ~/.config/brix/.env).")
    if "--once" in sys.argv:
        input("Press Enter to ask… ")
        one_shot(env_name, key)
        return
    print("brix voice — Ctrl-C to quit.")
    try:
        while True:
            input("Press Enter to ask… ")
            one_shot(env_name, key)
    except (KeyboardInterrupt, EOFError):
        print()


if __name__ == "__main__":
    main()
