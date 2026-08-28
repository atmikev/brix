# Third-Party Libraries & Attributions

Brix builds on the following third-party work. Each is used under its own
license; this file exists to satisfy those licenses' attribution requirements.
The MIT license text that governs the code Brix inherited is retained in
[LICENSE](LICENSE).

## Origin

Brix originated as a fork of **[Code Explainer](https://github.com/Royal-lobster/code-explainer)**
by Srujan Gurram, used under the MIT License:

> Copyright (c) 2026 Srujan Gurram
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction... (full text in [LICENSE](LICENSE)).

The extension server, highlight choreography, Kokoro TTS pipeline, and sidebar
playback derive from that project.

## Bundled into the VS Code extension

| Library | License | Source |
|---------|---------|--------|
| [ws](https://github.com/websockets/ws) | MIT | WebSocket server |

## Build-time (not distributed)

| Library | License | Source |
|---------|---------|--------|
| [esbuild](https://github.com/evanw/esbuild) | MIT | Bundler |
| [TypeScript](https://github.com/microsoft/TypeScript) | Apache-2.0 | Compiler |
| [@types/node](https://github.com/DefinitelyTyped/DefinitelyTyped), [@types/vscode], [@types/ws] | MIT | Type definitions |

## Python runtime (installed by `setup.sh` into a local venv)

| Library | License | Purpose |
|---------|---------|---------|
| [mlx-audio](https://github.com/Blaizzy/mlx-audio) | MIT | Text-to-speech synthesis (Kokoro) |
| [mlx-whisper](https://github.com/ml-explore/mlx-examples) | MIT | Local speech-to-text for voice questions |
| [misaki](https://github.com/hexgrad/misaki) | Apache-2.0 | Grapheme-to-phoneme for TTS |
| [sounddevice](https://github.com/spatialaudio/python-sounddevice) | MIT | Audio I/O |

## Models (downloaded on first use)

| Model | License | Purpose |
|-------|---------|---------|
| [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) | Apache-2.0 | Local TTS voice model |
| [Whisper](https://github.com/openai/whisper) (via [mlx-community](https://huggingface.co/mlx-community) conversions) | MIT | Local STT model |

## External tools (invoked, not bundled or distributed)

These are expected to be present on the host; Brix calls them as subprocesses
and does not ship them.

| Tool | License | Use |
|------|---------|-----|
| [ffmpeg](https://ffmpeg.org/) | LGPL-2.1+/GPL | Microphone capture for voice questions |
| [curl](https://curl.se/) | curl (MIT-style) | HTTP requests from shell helpers |
| [git](https://git-scm.com/) | GPL-2.0 | Diff/search for the navigator's read-only tools |

## Optional cloud services

Used only if explicitly configured; nothing is sent to them by default.

- **Anthropic API** and **OpenAI-compatible APIs** (incl. local [Ollama](https://ollama.com/) / [LM Studio](https://lmstudio.ai/)) — the navigator LLM.
- **Groq** / **OpenAI** Whisper APIs — optional fallback for voice transcription when a key is set (local mlx-whisper is the default).

---

If any attribution here is incomplete or incorrect, please open an issue.
