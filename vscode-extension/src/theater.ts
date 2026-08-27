import * as vscode from "vscode";
import type { FromWebviewMessage, Segment } from "./types";
import type { WalkthroughState } from "./walkthrough";

/**
 * Theater mode: a YouTube-shaped layout built from VS Code's editor grid.
 *
 *   ┌──────────────────────┬──────────┐
 *   │  real editor (code)  │ outline  │
 *   ├──────────────────────┴──────────┤
 *   │        playback controls        │
 *   └─────────────────────────────────┘
 *
 * The centre pane is a genuine text editor — webviews can't host one, and we
 * want real decorations, minimap and go-to-definition. Audio stays in the
 * sidebar webview (the retained playback host); these panels are UI only.
 */
export class TheaterView {
	private outline?: vscode.WebviewPanel;
	private controls?: vscode.WebviewPanel;
	private onMessage?: (msg: FromWebviewMessage) => void;
	private lastState?: WalkthroughState;
	private closing = false;
	/** True while a walkthrough owns theater mode — even if panels are hidden. */
	private armed = false;
	/** Set while we dispose panels ourselves, so onDidDispose doesn't disarm. */
	private suppressDisposeClose = false;
	private playbackCompleteResolve?: () => void;
	private chunkPlayedCallback?: () => void;

	constructor(private readonly extensionUri: vscode.Uri) {}

	setMessageHandler(handler: (msg: FromWebviewMessage) => void): void {
		this.onMessage = handler;
	}

	isOpen(): boolean {
		return this.outline !== undefined || this.controls !== undefined;
	}

	/** Theater mode is active for this walkthrough (panels may be temporarily hidden). */
	isArmed(): boolean {
		return this.armed;
	}

	/** Panels are currently on screen. */
	isVisible(): boolean {
		return this.isOpen();
	}

	/** Temporarily tear down the panels, keeping theater mode armed. */
	hide(): void {
		if (!this.isOpen()) return;
		this.suppressDisposeClose = true;
		this.outline?.dispose();
		this.controls?.dispose();
		this.outline = undefined;
		this.controls = undefined;
		this.suppressDisposeClose = false;
		vscode.commands.executeCommand("vscode.setEditorLayout", { orientation: 0, groups: [{}] });
	}

	/** Bring hidden panels back (no-op unless armed). */
	async showAgain(state: WalkthroughState): Promise<void> {
		if (!this.armed || this.isOpen()) return;
		await this.open(state);
	}

	/** Open the theater layout and show the given walkthrough state. */
	async open(state: WalkthroughState): Promise<void> {
		this.lastState = state;
		this.armed = true;

		if (this.isOpen()) {
			this.outline?.reveal(vscode.ViewColumn.Two, true);
			this.controls?.reveal(vscode.ViewColumn.Three, true);
			this.update(state);
			return;
		}

		// Code first, so it claims the main group.
		const seg = state.segments[state.currentIndex];
		if (seg) {
			const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(seg.file));
			await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false });
		}

		this.outline = vscode.window.createWebviewPanel(
			"brix.outline",
			"Outline",
			{ viewColumn: vscode.ViewColumn.Two, preserveFocus: true },
			{ enableScripts: true, retainContextWhenHidden: true },
		);
		this.outline.webview.html = outlineHtml(nonce());
		this.outline.webview.onDidReceiveMessage((m: FromWebviewMessage) => this.route(m));
		this.outline.onDidDispose(() => {
			this.outline = undefined;
			if (!this.suppressDisposeClose) this.close();
		});

		this.controls = vscode.window.createWebviewPanel(
			"brix.controls",
			"Brix Playback",
			{ viewColumn: vscode.ViewColumn.Three, preserveFocus: true },
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
			},
		);
		const audioUri = this.controls.webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, "media", "audio-player.js"),
		);
		this.controls.webview.html = controlsHtml(nonce(), audioUri.toString());
		this.controls.webview.onDidReceiveMessage((m: FromWebviewMessage) => {
			if (m.type === "playback_complete") {
				this.playbackCompleteResolve?.();
				this.playbackCompleteResolve = undefined;
				return;
			}
			if (m.type === "chunk_played") {
				this.chunkPlayedCallback?.();
				return;
			}
			this.route(m);
		});
		this.controls.onDidDispose(() => {
			this.controls = undefined;
			if (!this.suppressDisposeClose) this.close();
		});

		// code | outline on top, controls across the bottom
		await vscode.commands.executeCommand("vscode.setEditorLayout", {
			orientation: 1,
			groups: [
				{ groups: [{ size: 0.74 }, { size: 0.26 }], size: 0.76 },
				{ size: 0.24 },
			],
		});

		this.update(state);
	}

	/** Tear down the theater and restore a single editor group. */
	close(): void {
		if (this.closing) return;
		this.closing = true;
		this.armed = false;
		const outline = this.outline;
		const controls = this.controls;
		this.outline = undefined;
		this.controls = undefined;
		outline?.dispose();
		controls?.dispose();
		vscode.commands.executeCommand("vscode.setEditorLayout", { orientation: 0, groups: [{}] });
		this.closing = false;
	}

	update(state: WalkthroughState): void {
		this.lastState = state;
		const msg = {
			type: "update",
			title: state.title,
			segments: state.segments,
			currentSegment: state.segments[state.currentIndex]?.id ?? -1,
			status: state.status,
		};
		this.outline?.webview.postMessage(msg);
		this.controls?.webview.postMessage(msg);
	}

	sendHighlightAdvance(highlightIndex: number, totalHighlights: number, explanation?: string): void {
		const msg = { type: "highlight_advance", highlightIndex, totalHighlights, explanation };
		this.outline?.webview.postMessage(msg);
		this.controls?.webview.postMessage(msg);
	}

	// ── Audio host (same contract as SidebarProvider) ──

	private post(msg: unknown): void {
		this.controls?.webview.postMessage(msg);
	}

	sendAudioChunk(data: string, sampleRate: number): void {
		this.post({ type: "audio_chunk", data, sampleRate });
	}

	sendAudioEnd(): void {
		this.post({ type: "audio_end" });
	}

	sendAudioStop(): void {
		this.post({ type: "audio_stop" });
		this.playbackCompleteResolve?.();
		this.playbackCompleteResolve = undefined;
	}

	sendAudioSuspend(): void {
		this.post({ type: "audio_suspend" });
	}

	sendAudioResume(): void {
		this.post({ type: "audio_resume" });
	}

	waitForPlaybackComplete(): Promise<void> {
		this.playbackCompleteResolve?.();
		return new Promise((resolve) => {
			this.playbackCompleteResolve = resolve;
		});
	}

	setChunkPlayedCallback(cb: (() => void) | undefined): void {
		this.chunkPlayedCallback = cb;
	}

	sendValidity(validity: unknown): void {
		this.outline?.webview.postMessage({ type: "validity", validity });
	}

	sendServerLoading(loading: boolean): void {
		this.controls?.webview.postMessage({ type: "server_loading", loading });
	}

	private route(msg: FromWebviewMessage): void {
		this.onMessage?.(msg);
	}
}

function nonce(): string {
	let t = "";
	const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	for (let i = 0; i < 32; i++) t += chars.charAt(Math.floor(Math.random() * chars.length));
	return t;
}

const SHARED_CSS = `
	* { margin: 0; padding: 0; box-sizing: border-box; }
	body {
		font-family: var(--vscode-font-family);
		font-size: var(--vscode-font-size);
		color: var(--vscode-foreground);
		background: var(--vscode-editor-background);
	}
	button { font: inherit; color: inherit; cursor: pointer; background: none; border: none; }
	button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
`;

function outlineHtml(n: string): string {
	return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';">
<title>Outline</title><style>${SHARED_CSS}
	body { padding: 12px 10px; overflow-y: auto; height: 100vh; }
	h2 { font-size: 0.95em; font-weight: 600; margin-bottom: 2px; }
	.sub { font-size: 0.78em; opacity: 0.55; margin-bottom: 12px; }
	.item {
		display: flex; gap: 8px; align-items: flex-start; width: 100%; text-align: left;
		padding: 7px 8px; border-radius: 5px; margin-bottom: 2px; border-left: 2px solid transparent;
	}
	.item:hover { background: var(--vscode-list-hoverBackground); }
	.item.current { background: var(--vscode-list-activeSelectionBackground);
		color: var(--vscode-list-activeSelectionForeground); border-left-color: var(--vscode-charts-orange, #e2a144); }
	.item.done .label { opacity: 0.55; }
	.marker { width: 12px; flex-shrink: 0; font-size: 0.85em; opacity: 0.8; }
	.label { font-size: 0.88em; line-height: 1.35; }
	.loc { font-size: 0.75em; opacity: 0.5; margin-top: 2px; font-family: var(--vscode-editor-font-family, monospace); }
	.frac { margin-left: auto; font-size: 0.75em; opacity: 0.5; }
	.banner { font-size: 0.78em; line-height: 1.35; padding: 6px 8px; border-radius: 4px; margin-bottom: 10px; }
	.banner.stale { background: var(--vscode-inputValidation-errorBackground, rgba(200,70,50,0.15));
		border: 1px solid var(--vscode-inputValidation-errorBorder, rgba(200,70,50,0.5)); }
	.banner.shifted { background: var(--vscode-inputValidation-warningBackground, rgba(220,160,40,0.13));
		border: 1px solid var(--vscode-inputValidation-warningBorder, rgba(220,160,40,0.5)); }
	.warn { margin-left: 6px; font-size: 0.85em; }
	.warn.stale { color: var(--vscode-editorError-foreground, #d9705c); }
	.warn.shifted { color: var(--vscode-charts-orange, #e2a144); }
</style></head><body>
<div id="banner" class="banner" style="display:none"></div>
<h2 id="title"></h2>
<div class="sub" id="sub"></div>
<div id="list"></div>
<script nonce="${n}">
const vscode = acquireVsCodeApi();
let state = { title: "", segments: [], currentSegment: -1, status: "idle" };
let hlIndex = 0, hlTotal = 0, validity = null;

function render() {
	document.getElementById("title").textContent = state.title || "No walkthrough";
	const idx = state.segments.findIndex(s => s.id === state.currentSegment);
	document.getElementById("sub").textContent =
		state.segments.length ? "Segment " + (idx + 1) + " of " + state.segments.length : "";
	const banner = document.getElementById("banner");
	if (validity && validity.overall !== "fresh") {
		const stale = Object.values(validity.segments).filter(v => v.state === "stale").length;
		banner.style.display = "";
		banner.className = "banner " + (stale ? "stale" : "shifted");
		banner.textContent = stale
			? stale + " segment" + (stale === 1 ? "" : "s") + " no longer match the code — regenerate this walkthrough"
			: "Lines moved since this was made — positions were adjusted automatically";
	} else {
		banner.style.display = "none";
	}
	const list = document.getElementById("list");
	list.innerHTML = "";
	state.segments.forEach((seg, i) => {
		const b = document.createElement("button");
		b.className = "item" + (i === idx ? " current" : i < idx ? " done" : "");
		const marker = document.createElement("span");
		marker.className = "marker";
		marker.textContent = i < idx ? "\\u2713" : i === idx ? "\\u25B6" : "\\u25CB";
		const body = document.createElement("span");
		const label = document.createElement("div");
		label.className = "label";
		label.textContent = (i + 1) + ". " + seg.title;
		const loc = document.createElement("div");
		loc.className = "loc";
		loc.textContent = seg.file.split("/").pop() + ":" + seg.start + "-" + seg.end;
		body.appendChild(label); body.appendChild(loc);
		const total = (i === idx && hlTotal > 0) ? hlTotal : (seg.highlights || []).length;
		if (total > 1) {
			const frac = document.createElement("span");
			frac.className = "frac";
			frac.textContent = i < idx ? total + "/" + total : i === idx ? (hlIndex + 1) + "/" + total : "";
			b.appendChild(frac);
		}
		const v = validity && validity.segments ? validity.segments[seg.id] : null;
		if (v && v.state !== "fresh") {
			const warn = document.createElement("span");
			warn.className = "warn " + v.state;
			warn.textContent = v.state === "stale" ? "\u26A0" : "\u21C5";
			warn.title = v.state === "stale" ? (v.reason || "out of date") : "shifted " + v.delta + " lines";
			body.appendChild(warn);
		}
		b.appendChild(marker); b.appendChild(body);
		b.addEventListener("click", () => vscode.postMessage({ type: "goto_segment", segmentId: seg.id }));
		list.appendChild(b);
	});
}

window.addEventListener("message", (e) => {
	const m = e.data;
	if (m.type === "update") {
		if (m.currentSegment !== state.currentSegment) { hlIndex = 0; hlTotal = 0; }
		state = m; render();
	} else if (m.type === "highlight_advance") {
		hlIndex = m.highlightIndex; hlTotal = m.totalHighlights; render();
	} else if (m.type === "validity") {
		validity = m.validity; render();
	}
});
render();
</script></body></html>`;
}

function controlsHtml(n: string, audioUri: string): string {
	return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';">
<title>Brix Playback</title><style>${SHARED_CSS}
	body { height: 100vh; display: flex; flex-direction: column; padding: 10px 16px 12px; gap: 8px; }
	.progress { height: 3px; border-radius: 2px; background: var(--vscode-panel-border); overflow: hidden; flex-shrink: 0; }
	.progress-fill { height: 100%; width: 0%; background: var(--vscode-progressBar-background); transition: width 0.35s ease; }
	.row { display: flex; align-items: center; gap: 14px; flex-shrink: 0; }
	.transport { display: flex; align-items: center; gap: 8px; }
	.tbtn {
		width: 34px; height: 30px; border-radius: 6px; display: flex; align-items: center; justify-content: center;
		background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
	}
	.tbtn:hover { background: var(--vscode-button-secondaryHoverBackground); }
	.play {
		width: 42px; height: 42px; border-radius: 50%;
		background: var(--vscode-button-background); color: var(--vscode-button-foreground);
	}
	.play:hover { background: var(--vscode-button-hoverBackground); }
	.play.loading { opacity: 0.7; pointer-events: none; }
	.now { min-width: 0; flex: 1; }
	.seg-title { font-weight: 600; font-size: 0.95em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.seg-loc { font-size: 0.78em; opacity: 0.55; font-family: var(--vscode-editor-font-family, monospace); }
	.counter { font-size: 0.8em; opacity: 0.6; font-variant-numeric: tabular-nums; }
	.opts { display: flex; align-items: center; gap: 10px; }
	.speeds { display: flex; gap: 3px; }
	.speeds button { padding: 3px 8px; border-radius: 4px; font-size: 0.8em;
		background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
	.speeds button.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
	select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground);
		border: 1px solid var(--vscode-dropdown-border); border-radius: 4px; padding: 3px 6px; font-size: 0.8em; }
	input[type=range] { width: 90px; accent-color: var(--vscode-focusBorder); }
	.explain {
		flex: 1; min-height: 0; overflow-y: auto; font-size: 0.9em; line-height: 1.5;
		border-top: 1px solid var(--vscode-panel-border); padding-top: 8px; opacity: 0.9;
	}
	.explain:empty { display: none; }
</style></head><body>
<div class="progress"><div class="progress-fill" id="fill"></div></div>
<div class="row">
	<div class="transport">
		<button class="tbtn" id="prev" title="Previous (Shift: segment)">&#9198;</button>
		<button class="play" id="play" title="Play/Pause">&#9654;</button>
		<button class="tbtn" id="next" title="Next (Shift: segment)">&#9197;</button>
	</div>
	<div class="now">
		<div class="seg-title" id="seg-title">No walkthrough loaded</div>
		<div class="seg-loc" id="seg-loc"></div>
	</div>
	<span class="counter" id="counter"></span>
	<div class="opts">
		<div class="speeds" id="speeds">
			<button data-speed="1" class="active">1x</button>
			<button data-speed="1.25">1.25x</button>
			<button data-speed="1.5">1.5x</button>
			<button data-speed="2">2x</button>
		</div>
		<select id="voice">
			<option value="af_heart">Heart (F)</option>
			<option value="af_bella">Bella (F)</option>
			<option value="af_sarah">Sarah (F)</option>
			<option value="am_adam">Adam (M)</option>
			<option value="am_michael">Michael (M)</option>
			<option value="bf_emma">Emma (BF)</option>
			<option value="bm_george">George (BM)</option>
		</select>
		<input type="range" id="vol" min="0" max="100" value="80" title="Volume">
	</div>
</div>
<div class="explain" id="explain"></div>
<script nonce="${n}" src="${audioUri}"></script>
<script nonce="${n}">
const vscode = acquireVsCodeApi();
let state = { title: "", segments: [], currentSegment: -1, status: "idle" };
let hlIndex = 0, hlTotal = 0, shift = false;

function md(t) {
	if (!t) return "";
	return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
		.replace(/\\*\\*(.+?)\\*\\*/g, "<strong>$1</strong>")
		.replace(/\`(.+?)\`/g, "<code>$1</code>")
		.replace(/\\n/g, "<br>");
}

function progress() {
	let total = 0, done = 0;
	const idx = state.segments.findIndex(s => s.id === state.currentSegment);
	state.segments.forEach((s, i) => {
		const c = (s.highlights && s.highlights.length) ? s.highlights.length : 1;
		total += c;
		if (i < idx) done += c;
		else if (i === idx) done += hlIndex;
	});
	return { done: done + 1, total };
}

function render() {
	const seg = state.segments.find(s => s.id === state.currentSegment);
	document.getElementById("seg-title").textContent = seg ? seg.title : "No walkthrough loaded";
	document.getElementById("seg-loc").textContent = seg ? seg.file.split("/").pop() + ":" + seg.start + "-" + seg.end : "";
	document.getElementById("play").innerHTML = state.status === "playing" ? "&#10074;&#10074;" : "&#9654;";
	const p = progress();
	document.getElementById("counter").textContent = p.total ? p.done + "/" + p.total : "";
	document.getElementById("fill").style.width = p.total ? (p.done / p.total * 100) + "%" : "0%";
	if (seg) document.getElementById("explain").innerHTML = md(seg.explanation);
}

document.getElementById("play").addEventListener("click", () => {
	ensureAudioContext(); // unlock in THIS document — gestures don't cross webviews
	vscode.postMessage({ type: "play_pause" });
});
document.getElementById("next").addEventListener("click", () =>
	vscode.postMessage({ type: shift || hlTotal <= 1 ? "next" : "next_highlight" }));
document.getElementById("prev").addEventListener("click", () =>
	vscode.postMessage({ type: shift || hlTotal <= 1 ? "prev" : "prev_highlight" }));
document.getElementById("voice").addEventListener("change", (e) =>
	vscode.postMessage({ type: "voice_change", voice: e.target.value }));
document.getElementById("vol").addEventListener("input", (e) => {
	volume = parseInt(e.target.value, 10) / 100;
	updateVolume();
	vscode.postMessage({ type: "volume_change", volume });
});
document.querySelectorAll("#speeds button").forEach((b) => {
	b.addEventListener("click", () => {
		document.querySelectorAll("#speeds button").forEach(x => x.classList.remove("active"));
		b.classList.add("active");
		vscode.postMessage({ type: "speed_change", speed: parseFloat(b.dataset.speed) });
	});
});
document.addEventListener("keydown", (e) => {
	if (e.key === "Shift") shift = true;
	if (e.code === "Space" && e.target.tagName !== "BUTTON" && e.target.tagName !== "SELECT" && e.target.tagName !== "INPUT") {
		e.preventDefault();
		vscode.postMessage({ type: "play_pause" });
	}
});
document.addEventListener("keyup", (e) => { if (e.key === "Shift") shift = false; });

window.addEventListener("message", (e) => {
	const m = e.data;
	if (m.type === "update") {
		if (m.currentSegment !== state.currentSegment) { hlIndex = 0; hlTotal = 0; }
		state = m; render();
	} else if (m.type === "highlight_advance") {
		hlIndex = m.highlightIndex; hlTotal = m.totalHighlights;
		if (m.explanation) document.getElementById("explain").innerHTML = md(m.explanation);
		render();
	} else if (m.type === "server_loading") {
		document.getElementById("play").classList.toggle("loading", m.loading);
	} else if (m.type === "audio_chunk") {
		document.getElementById("play").classList.remove("loading");
		playAudioChunk(m.data, m.sampleRate);
	} else if (m.type === "audio_end") {
		onAudioEnd();
	} else if (m.type === "audio_stop") {
		stopAudio();
	} else if (m.type === "audio_suspend") {
		suspendAudio();
	} else if (m.type === "audio_resume") {
		resumeAudio();
	} else if (m.type === "set_volume") {
		volume = m.volume; updateVolume();
		document.getElementById("vol").value = String(Math.round(volume * 100));
	}
});
render();
</script></body></html>`;
}
