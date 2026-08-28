#!/usr/bin/env python3
"""Persistent TTS server — loads model once, streams audio chunks via Unix socket.

Eliminates ~5s cold-start per call by keeping the model in memory.
Audio is streamed chunk-by-chunk to the client for immediate playback.

Usage:
    tts_server.py              # Start server (foreground)
    tts_server.py --daemon     # Start server (background)

Clients send JSON over the Unix socket:
    {"text": "Hello world", "voice": "af_heart", "speed": 1.0}

Server responds with streamed audio:
    [4-byte big-endian length][float32 audio data] per chunk
    [4 bytes: 0x00000000] to signal end of stream
"""

import json
import os
import signal
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import threading
import time


def _runtime_dir() -> str:
    """Per-user 0700 dir for the socket/pid/log. A shared /tmp let any other
    local user connect to the socket, squat the predictable paths, or symlink
    the log; a private dir owned by us closes all three."""
    d = os.path.join(tempfile.gettempdir(), f"brix-{os.getuid()}")
    os.makedirs(d, mode=0o700, exist_ok=True)
    st = os.lstat(d)
    if st.st_uid != os.getuid() or not stat.S_ISDIR(st.st_mode) or (st.st_mode & 0o077):
        raise RuntimeError(f"insecure runtime dir: {d}")
    return d


RUNTIME_DIR = _runtime_dir()
SOCKET_PATH = os.path.join(RUNTIME_DIR, "tts-server.sock")
PID_FILE = os.path.join(RUNTIME_DIR, "tts-server.pid")
LOG_FILE = os.path.join(RUNTIME_DIR, "tts-server.log")
DEFAULT_VOICE = os.environ.get("TTS_VOICE", "af_heart")
DEFAULT_SPEED = float(os.environ.get("TTS_SPEED", "1.0"))
# TTS_MODEL is loaded by mlx_audio, which can execute code on load — keep it a
# trusted HuggingFace repo; do not source it from untrusted input.
DEFAULT_MODEL = os.environ.get("TTS_MODEL", "prince-canuma/Kokoro-82M")
IDLE_TIMEOUT = int(os.environ.get("TTS_IDLE_TIMEOUT", "300"))  # 5 min default


def load_tts(model_id: str):
    """Load the TTS model and pipeline once."""
    from mlx_audio.tts.models.kokoro import KokoroPipeline
    from mlx_audio.tts.utils import load_model

    print(f"[tts-server] Loading model {model_id}...", flush=True)
    model = load_model(model_id)
    pipeline = KokoroPipeline(lang_code="a", model=model, repo_id=model_id)
    print("[tts-server] Model loaded, ready.", flush=True)
    return pipeline


def generate_and_stream(conn, pipeline, text: str, voice: str, speed: float):
    """Generate audio chunks and stream them to the client."""
    import numpy as np

    for result in pipeline(
        text, voice=voice, speed=speed, split_pattern=r"(?<=[.!?])\s+"
    ):
        audio = np.array(result.audio).squeeze().astype(np.float32)
        audio_bytes = audio.tobytes()
        header = struct.pack("!I", len(audio_bytes))
        try:
            conn.sendall(header + audio_bytes)
        except BrokenPipeError:
            return

    try:
        conn.sendall(struct.pack("!I", 0))
    except BrokenPipeError:
        pass


def cleanup(*_):
    """Remove socket and pid file on exit."""
    for path in (SOCKET_PATH, PID_FILE):
        try:
            os.unlink(path)
        except OSError:
            pass
    sys.exit(0)


def is_server_alive() -> bool:
    """Check if an existing TTS server process is still running."""
    try:
        with open(PID_FILE, "r") as f:
            pid = int(f.read().strip())
        os.kill(pid, 0)  # signal 0 = check if alive
        return True
    except (FileNotFoundError, ValueError, ProcessLookupError, PermissionError):
        return False


def cleanup_stale():
    """Remove stale socket and PID file from a dead server."""
    for path in (SOCKET_PATH, PID_FILE):
        try:
            os.unlink(path)
        except OSError:
            pass


def run_server():
    # If another server is alive, exit instead of fighting for the socket
    if is_server_alive():
        print("[tts-server] Another instance is already running, exiting.", flush=True)
        sys.exit(0)

    # Clean up stale files from a crashed previous run
    cleanup_stale()

    with open(PID_FILE, "w") as f:
        f.write(str(os.getpid()))

    signal.signal(signal.SIGTERM, cleanup)
    signal.signal(signal.SIGINT, cleanup)

    pipeline = load_tts(DEFAULT_MODEL)
    last_activity = time.monotonic()

    def idle_watchdog():
        """Shut down the server after IDLE_TIMEOUT seconds of inactivity."""
        while True:
            time.sleep(30)
            idle = time.monotonic() - last_activity
            if idle >= IDLE_TIMEOUT:
                print(
                    f"[tts-server] Idle for {int(idle)}s, shutting down to free memory.",
                    flush=True,
                )
                # Send SIGTERM to main thread — sys.exit() from a daemon thread
                # only kills the thread, not the process
                os.kill(os.getpid(), signal.SIGTERM)
                return

    if IDLE_TIMEOUT > 0:
        watchdog = threading.Thread(target=idle_watchdog, daemon=True)
        watchdog.start()
        print(f"[tts-server] Will auto-shutdown after {IDLE_TIMEOUT}s idle.", flush=True)

    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    # Create the socket unconnectable-by-others from the start (the 0700 parent
    # dir already blocks other users; this closes the pre-chmod race too).
    old_umask = os.umask(0o177)
    try:
        server.bind(SOCKET_PATH)
    finally:
        os.umask(old_umask)
    server.listen(5)
    os.chmod(SOCKET_PATH, 0o600)

    print(f"[tts-server] Listening on {SOCKET_PATH}", flush=True)

    while True:
        conn, _ = server.accept()
        try:
            data = b""
            while True:
                chunk = conn.recv(4096)
                if not chunk:
                    break
                data += chunk

            if not data:
                conn.close()
                continue

            last_activity = time.monotonic()

            request = json.loads(data.decode("utf-8"))

            if request.get("ping"):
                conn.sendall(struct.pack("!I", 0))
                continue

            text = request.get("text", "").strip()
            voice = request.get("voice", DEFAULT_VOICE)
            speed = request.get("speed", DEFAULT_SPEED)

            if text:
                generate_and_stream(conn, pipeline, text, voice, speed)
            else:
                conn.sendall(struct.pack("!I", 0))
        except Exception as e:
            print(f"[tts-server] Error: {e}", flush=True)
        finally:
            conn.close()


def find_venv_python():
    """Find the venv Python that has mlx-audio installed."""
    # Check TTS_WORKSPACE_ROOT first (set by VS Code extension)
    workspace_root = os.environ.get("TTS_WORKSPACE_ROOT")
    if workspace_root:
        venv_python = os.path.join(workspace_root, ".venv", "bin", "python3")
        if os.path.isfile(venv_python):
            return os.path.abspath(venv_python)
    # Fallback: relative to script (works when script is in project/scripts/)
    script_dir = os.path.dirname(os.path.abspath(__file__))
    venv_python = os.path.join(script_dir, "..", ".venv", "bin", "python3")
    if os.path.isfile(venv_python):
        return os.path.abspath(venv_python)
    return sys.executable


if __name__ == "__main__":
    if "--daemon" in sys.argv:
        python_bin = find_venv_python()
        # O_NOFOLLOW: never append through a symlink someone else planted.
        log_fd = os.open(LOG_FILE, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
        log = os.fdopen(log_fd, "a")
        proc = subprocess.Popen(
            [python_bin, __file__],
            stdout=log,
            stderr=log,
            start_new_session=True,
        )
        print(f"[tts-server] Started daemon (PID {proc.pid}) using {python_bin}")
        sys.exit(0)

    run_server()
