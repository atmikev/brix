#!/usr/bin/env python3
"""Voice questions for brix — push-to-talk mic → Whisper → brix.sh ask.

Speak a question about the step you're viewing; it's transcribed and routed to
the navigator (or your coding agent) grounded at the current walkthrough step.

Usage:
    voice.py                 # push-to-talk loop: Enter to record, Enter to stop
    voice.py --once          # record one question and exit
    voice.py --selftest      # report the transcription backend, no mic

Transcription is LOCAL and keyless by default via mlx-whisper (the same MLX
stack brix uses for TTS) — no audio leaves the machine. If mlx-whisper isn't
installed in the brix venv, it falls back to the Groq or OpenAI Whisper API
when GROQ_API_KEY (preferred) or OPENAI_API_KEY is set (env, ~/.config/brix/.env,
or ~/.config/watch/.env).

Audio capture uses ffmpeg (avfoundation). Override the mic with
BRIX_AUDIO_DEVICE (default ":0"), the local model with BRIX_WHISPER_MODEL, or
force fixed-length capture with BRIX_RECORD_SECONDS.
"""

import os
import subprocess
import sys
import tempfile

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BRIX = os.path.join(SCRIPT_DIR, "brix.sh")
AUDIO_DEVICE = os.environ.get("BRIX_AUDIO_DEVICE", ":0")
WHISPER_MODEL = os.environ.get("BRIX_WHISPER_MODEL", "mlx-community/whisper-large-v3-turbo")

# venvs that may hold mlx-whisper (same candidates the TTS bridge probes)
VENV_CANDIDATES = [
    os.path.join(os.path.dirname(SCRIPT_DIR), ".venv"),
    os.path.expanduser("~/.claude/skills/brix/.venv"),
    os.path.join(os.getcwd(), ".venv"),
]

CLOUD_PROVIDERS = {
    "GROQ_API_KEY": ("https://api.groq.com/openai/v1/audio/transcriptions", "whisper-large-v3"),
    "OPENAI_API_KEY": ("https://api.openai.com/v1/audio/transcriptions", "whisper-1"),
}


def clean(text):
    return (text or "").strip()


# ── Transcription backends ──

def find_local_whisper():
    """A venv python that can import mlx_whisper, or None."""
    seen = set()
    for base in VENV_CANDIDATES:
        py = os.path.join(base, "bin", "python3")
        if py in seen or not os.path.exists(py):
            continue
        seen.add(py)
        if subprocess.run([py, "-c", "import mlx_whisper"], capture_output=True).returncode == 0:
            return py
    return None


def transcribe_local(py, wav):
    r = subprocess.run(
        [py, "-c",
         # truststore first: trust the OS keychain so the model download works
         # behind a corporate TLS proxy (Zscaler). No-op if not installed.
         "try:\n import truststore; truststore.inject_into_ssl()\nexcept Exception:\n pass\n"
         "import sys, mlx_whisper; "
         "print(mlx_whisper.transcribe(sys.argv[1], path_or_hf_repo=sys.argv[2])['text'])",
         wav, WHISPER_MODEL],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        raise RuntimeError((r.stderr or "").strip()[:300] or "mlx_whisper failed")
    return clean(r.stdout)


def load_key():
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
    for name in CLOUD_PROVIDERS:
        if envs.get(name):
            return name, envs[name]
    return None, None


def transcribe_cloud(wav, env_name, key):
    url, model = CLOUD_PROVIDERS[env_name]
    out = subprocess.run(
        ["curl", "-sS", url, "-H", f"Authorization: Bearer {key}",
         "-F", f"file=@{wav}", "-F", f"model={model}", "-F", "response_format=text"],
        capture_output=True, text=True,
    )
    return clean(out.stdout)


def make_transcriber():
    """Prefer local mlx-whisper (keyless, offline); fall back to a cloud key."""
    py = find_local_whisper()
    if py:
        return f"local mlx-whisper ({WHISPER_MODEL})", lambda wav: transcribe_local(py, wav)
    env_name, key = load_key()
    if key:
        return f"{env_name.split('_')[0]} Whisper API (cloud)", lambda wav: transcribe_cloud(wav, env_name, key)
    return None, None


# ── Mic capture ──

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


# ── Orchestration ──

def ask(question):
    subprocess.run([BRIX, "ask", question], check=False)


def one_shot(transcribe):
    seconds = os.environ.get("BRIX_RECORD_SECONDS")
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        wav = tmp.name
    try:
        record(wav, int(seconds) if seconds else None)
        question = transcribe(wav)
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
    backend, _ = make_transcriber()
    print(f"transcription: {backend or 'NONE — pip install mlx-whisper, or set GROQ_API_KEY/OPENAI_API_KEY'}")
    print(f"brix.sh:       {'found' if os.path.exists(BRIX) else 'MISSING'} at {BRIX}")
    print("selftest OK")


def main():
    if "--selftest" in sys.argv:
        selftest()
        return
    backend, transcribe = make_transcriber()
    if not transcribe:
        sys.exit("No transcription backend. Install mlx-whisper in the brix venv "
                 "(pip install mlx-whisper), or set GROQ_API_KEY / OPENAI_API_KEY.")
    print(f"brix voice — {backend}. Ctrl-C to quit.")
    if "--once" in sys.argv:
        input("Press Enter to ask… ")
        one_shot(transcribe)
        return
    try:
        while True:
            input("Press Enter to ask… ")
            one_shot(transcribe)
    except (KeyboardInterrupt, EOFError):
        print()


if __name__ == "__main__":
    main()
