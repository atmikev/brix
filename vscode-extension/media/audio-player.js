// @ts-check
// Shared Web Audio player — loaded by BOTH the sidebar webview and the theater
// controls panel. An AudioContext can only be unlocked by a user gesture in its
// OWN document, so each surface that has a play button needs its own player;
// the extension routes audio to whichever one is currently the host.
// Relies on a global `vscode` (acquireVsCodeApi) defined by the host page.

// ── Audio player ──

/** @type {AudioContext | null} */
let audioCtx = null;
/** @type {GainNode | null} */
let gainNode = null;
let nextPlayTime = 0;
/** @type {AudioBufferSourceNode[]} */
let activeSources = [];
// Speed is handled by TTS server; Web Audio plays at 1x
let volume = 0.8;
let muted = false;
let audioPlaying = false;
/** True when audio was intentionally suspended via suspendAudio() (user pause). */
let intentionallySuspended = false;
let currentHighlightIndex = 0;
let totalHighlights = 0;
/** True when audio_end arrived but chunks are still pending (AudioContext suspended) */
let deferredPlaybackComplete = false;
/** Guard: true while waitForActiveSourcesToFinish has a pending wrapper or sent playback_complete */
let playbackCompleteWired = false;

/** @type {{base64: string, sampleRate: number}[]} */
let pendingChunks = [];

function ensureAudioContext() {
	if (!audioCtx) {
		audioCtx = new AudioContext({ sampleRate: 24000 });
		gainNode = audioCtx.createGain();
		gainNode.gain.value = muted ? 0 : volume;
		gainNode.connect(audioCtx.destination);
	}
	if (audioCtx.state === "suspended" && !intentionallySuspended) {
		audioCtx.resume().then(() => {
			// Flush any chunks that arrived while suspended
			const chunks = pendingChunks.slice();
			pendingChunks = [];
			for (const chunk of chunks) {
				playAudioChunk(chunk.base64, chunk.sampleRate);
			}
			// If audio_end arrived while suspended, now handle deferred playback completion
			if (deferredPlaybackComplete) {
				deferredPlaybackComplete = false;
				waitForActiveSourcesToFinish();
			}
		});
	}
}

// Pre-warm AudioContext on first user interaction so it's ready when audio arrives
document.addEventListener("click", () => ensureAudioContext(), { once: true });


function playAudioChunk(base64Data, sampleRate) {
	ensureAudioContext();

	// If AudioContext is still suspended (no user gesture yet), queue the chunk
	if (audioCtx.state === "suspended") {
		pendingChunks.push({ base64: base64Data, sampleRate });
		return;
	}

	const binary = atob(base64Data);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	const float32 = new Float32Array(bytes.buffer);

	const buffer = audioCtx.createBuffer(1, float32.length, sampleRate);
	buffer.getChannelData(0).set(float32);

	const source = audioCtx.createBufferSource();
	source.buffer = buffer;
	source.playbackRate.value = 1;
	source.connect(gainNode);

	const now = audioCtx.currentTime;
	if (nextPlayTime < now) nextPlayTime = now;
	source.start(nextPlayTime);
	nextPlayTime += buffer.duration;

	activeSources.push(source);
	source.onended = () => {
		const idx = activeSources.indexOf(source);
		if (idx !== -1) activeSources.splice(idx, 1);
		vscode.postMessage({ type: "chunk_played" });
	};

	audioPlaying = true;
}

function stopAudio() {
	intentionallySuspended = false;
	for (const source of activeSources) {
		// Clear onended BEFORE stopping to prevent stale playback_complete messages.
		// Without this, wrapped onended callbacks (from waitForActiveSourcesToFinish)
		// fire and send playback_complete which can resolve the NEXT chunk's promise,
		// causing the highlight loop to skip subsegments and leak orphaned TTS streams.
		source.onended = null;
		try { source.stop(); } catch {}
	}
	activeSources = [];
	pendingChunks = [];
	nextPlayTime = 0;
	audioPlaying = false;
	deferredPlaybackComplete = false;
	playbackCompleteWired = false;
}

/** Suspend AudioContext to freeze audio in place (pause mid-highlight). */
function suspendAudio() {
	if (audioCtx && audioCtx.state === "running") {
		intentionallySuspended = true;
		audioCtx.suspend();
	}
	// Don't clear sources or nextPlayTime — we want to resume from here
}

/** Resume AudioContext and wait for remaining buffered audio to finish. */
function resumeAudio() {
	intentionallySuspended = false;
	if (audioCtx && audioCtx.state === "suspended") {
		// Always resume the AudioContext so subsequent playAudioChunk() calls
		// don't silently push to pendingChunks instead of playing.
		audioCtx.resume().then(() => {
			waitForActiveSourcesToFinish();
		});
	} else {
		// Nothing to resume — signal immediately so extension can re-stream
		vscode.postMessage({ type: "playback_complete" });
	}
}

/**
 * Wait for all active audio sources to finish, then send playback_complete.
 * If no sources are active (already drained), sends immediately.
 * Idempotent: safe to call multiple times (onAudioEnd + resumeAudio) —
 * only the first call wires the wrapper; subsequent calls are no-ops.
 */
function waitForActiveSourcesToFinish() {
	if (playbackCompleteWired || intentionallySuspended) return;
	playbackCompleteWired = true;
	if (activeSources.length === 0) {
		audioPlaying = false;
		playbackCompleteWired = false;
		vscode.postMessage({ type: "playback_complete" });
		return;
	}
	const lastSource = activeSources[activeSources.length - 1];
	const originalOnEnded = lastSource.onended;
	lastSource.onended = (e) => {
		if (originalOnEnded) originalOnEnded.call(lastSource, e);
		audioPlaying = false;
		playbackCompleteWired = false;
		vscode.postMessage({ type: "playback_complete" });
	};
}

function onAudioEnd() {
	// Wait for actual Web Audio playback to finish,
	// then signal the extension so it can advance to the next sub-highlight.
	// If chunks are still pending (AudioContext suspended), defer until they're flushed.
	if (pendingChunks.length > 0) {
		deferredPlaybackComplete = true;
		return;
	}
	waitForActiveSourcesToFinish();
}

function updateVolume() {
	if (gainNode) {
		gainNode.gain.value = muted ? 0 : volume;
	}
}

