import * as vscode from "vscode";
import type { ToWebviewMessage, FromWebviewMessage } from "./types";
import type { WalkthroughState } from "./walkthrough";

export class SidebarProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = "brix.sidebar";

	private view?: vscode.WebviewView;
	private onMessage?: (msg: FromWebviewMessage) => void | Promise<void>;
	private playbackCompleteResolve?: () => void;
	private chunkPlayedCallback?: () => void;

	constructor(private readonly extensionUri: vscode.Uri) {}

	setMessageHandler(handler: (msg: FromWebviewMessage) => void | Promise<void>): void {
		this.onMessage = handler;
	}

	resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	): void {
		this.view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
		};

		webviewView.webview.html = this.getHtml(webviewView.webview);

		webviewView.webview.onDidReceiveMessage((msg: FromWebviewMessage) => {
			if (msg.type === "playback_complete") {
				this.playbackCompleteResolve?.();
				this.playbackCompleteResolve = undefined;
				return;
			}
			if (msg.type === "chunk_played") {
				this.chunkPlayedCallback?.();
				return;
			}
			this.onMessage?.(msg);
		});
	}

	/** Reveal and focus the sidebar panel */
	reveal(): void {
		if (this.view) {
			this.view.show?.(true);
		} else {
			// If webview isn't resolved yet, open the sidebar view
			vscode.commands.executeCommand("brix.sidebar.focus");
		}
	}

	/** Send a message to the webview */
	postMessage(msg: ToWebviewMessage): void {
		this.view?.webview.postMessage(msg);
	}

	/** Send full state update to webview */
	updateState(state: WalkthroughState): void {
		this.postMessage({
			type: "update",
			title: state.title,
			segments: state.segments,
			currentSegment: state.segments[state.currentIndex]?.id ?? -1,
			status: state.status,
		});
	}

	/** Send audio chunk to webview */
	sendAudioChunk(base64Data: string, sampleRate: number): void {
		this.postMessage({
			type: "audio_chunk",
			data: base64Data,
			sampleRate,
		});
	}

	sendAudioEnd(): void {
		this.postMessage({ type: "audio_end" });
	}

	sendAudioStop(): void {
		this.postMessage({ type: "audio_stop" });
		// Resolve any pending playback wait since audio was forcefully stopped
		this.playbackCompleteResolve?.();
		this.playbackCompleteResolve = undefined;
	}

	/** Suspend audio in webview (freeze in place for mid-highlight pause). */
	sendAudioSuspend(): void {
		this.postMessage({ type: "audio_suspend" });
		// Do NOT resolve playbackCompleteResolve here. Keeping the old
		// playSegmentHighlights loop alive at `await playbackDone` preserves
		// the chunkPlayedCallback so highlights continue advancing on resume.
	}

	/** Resume suspended audio in webview. */
	sendAudioResume(): void {
		this.postMessage({ type: "audio_resume" });
	}

	/** Returns a promise that resolves when the webview signals playback is done */
	waitForPlaybackComplete(): Promise<void> {
		// Resolve any dangling previous wait to prevent leaked promises
		this.playbackCompleteResolve?.();
		return new Promise((resolve) => {
			this.playbackCompleteResolve = resolve;
		});
	}

	/** Register a callback fired each time the webview finishes playing one audio chunk. */
	setChunkPlayedCallback(cb: (() => void) | undefined): void {
		this.chunkPlayedCallback = cb;
	}

	sendServerLoading(loading: boolean): void {
		this.postMessage({ type: "server_loading", loading });
	}

	sendHighlightAdvance(highlightIndex: number, totalHighlights: number, explanation?: string): void {
		this.postMessage({
			type: "highlight_advance",
			highlightIndex,
			totalHighlights,
			explanation,
		});
	}

	/** Push the distilled transcript feed to the webview. */
	sendFeed(items: import("./types").FeedItem[]): void {
		this.postMessage({ type: "feed", items });
	}

	/** Push the decision list to the webview and update the view badge. */
	sendDecisions(decisions: import("./types").Decision[]): void {
		this.postMessage({ type: "decisions", decisions });
		const open = decisions.filter((d) => d.status === "open").length;
		if (this.view) {
			this.view.badge = open > 0
				? { value: open, tooltip: `${open} decision${open === 1 ? "" : "s"} waiting on you` }
				: undefined;
		}
	}

	private getHtml(webview: vscode.Webview): string {
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, "media", "sidebar.js"),
		);
		const audioUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, "media", "audio-player.js"),
		);
		const styleUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, "media", "sidebar.css"),
		);
		const nonce = getNonce();

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy"
		content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link rel="stylesheet" href="${styleUri}">
	<title>Brix</title>
</head>
<body>
	<div id="decisions-section" style="display:none;">
		<div class="decisions-header">
			<span class="decisions-label">WAITING ON YOU</span>
			<span id="decisions-count" class="decisions-count"></span>
			<button id="decisions-expand" class="icon-btn decisions-expand" title="Open all decisions in editor">
				<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
					<path d="M9 1v1.5h3.44L6.22 8.72l1.06 1.06L13.5 3.56V7H15V1H9z"/>
					<path d="M12.5 13.5h-9v-9H8V3H3.5A1.5 1.5 0 002 4.5v9A1.5 1.5 0 003.5 15h9a1.5 1.5 0 001.5-1.5V9h-1.5v4.5z"/>
				</svg>
			</button>
		</div>
		<div id="decisions-list"></div>
	</div>

	<div id="feed-section" style="display:none;">
		<div class="feed-header">
			<span class="feed-label">UPDATES</span>
			<button id="feed-clear" class="feed-clear" title="Clear updates">clear</button>
		</div>
		<div id="feed-list"></div>
	</div>

	<div id="idle-view">
		<div class="idle-header">
			<span class="idle-header-label">BRIX</span>
		</div>
		<div class="idle-hero">
			<svg class="idle-icon" width="32" height="32" viewBox="0 0 16 16" fill="currentColor" opacity="0.4">
				<path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 12.5a5.5 5.5 0 110-11 5.5 5.5 0 010 11zM6.5 5v6l5-3-5-3z"/>
			</svg>
			<p class="idle-text">No walkthrough loaded</p>
			<p class="idle-hint">Run <code>/brix</code> in your coding agent to generate one</p>
		</div>
		<div id="saved-list-section" style="display:none;">
			<h3 class="saved-list-title">Recent walkthroughs</h3>
			<ul id="saved-list"></ul>
		</div>
	</div>

	<div id="active-view" style="display:none;">
		<div class="sticky-top">
			<div class="header">
				<span class="header-label">BRIX</span>
				<div class="header-actions">
					<button id="btn-theater" class="icon-btn" title="Open theater view (editor + outline + controls)">
						<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
							<path d="M1.5 2h13A1.5 1.5 0 0116 3.5v9a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 010 12.5v-9A1.5 1.5 0 011.5 2zm0 1.5v9H10v-9H1.5zm10 0v4H14.5v-4h-3zm3 5.5h-3v3.5h3V9z"/>
						</svg>
					</button>
					<button id="btn-save" class="icon-btn" title="Save Walkthrough">
						<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
							<path d="M13.354 4.354l-3.708-3.708A.5.5 0 009.293.5H2.5A1.5 1.5 0 001 2v12a1.5 1.5 0 001.5 1.5h11A1.5 1.5 0 0015 14V4.707a.5.5 0 00-.146-.353zM12 14H4V9h8v5zm1-7H3V2h6.293L13 5.707V7z"/>
						</svg>
					</button>
					<button id="btn-close" class="icon-btn" title="Close Walkthrough">
						<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
							<path d="M8 8.707l3.646 3.647.708-.708L8.707 8l3.647-3.646-.708-.708L8 7.293 4.354 3.646l-.708.708L7.293 8l-3.647 3.646.708.708L8 8.707z"/>
						</svg>
					</button>
				</div>
			</div>
			<h2 id="walkthrough-title"></h2>
				<div id="validity-banner" class="validity-banner" style="display:none;"></div>

			<div class="now-playing">
				<div class="progress-bar"><div id="progress-fill" class="progress-fill"></div></div>
				<span id="segment-counter" class="counter"></span>
				<span id="segment-title" class="seg-title"></span>
				<a id="segment-location" class="seg-location" href="#"></a>
			</div>

			<div class="controls">
				<button id="btn-prev" title="Hold Shift to skip entire segment">
					<svg class="icon-highlight" width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M10 2L4 8l6 6V2z"/></svg>
					<svg class="icon-segment" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" style="display:none"><path d="M3 3h2v10H3V3zm10 0L7 8l6 5V3z"/></svg>
				</button>
				<button id="btn-play-pause" class="play-btn" title="Play/Pause">
					<svg class="icon-play" width="18" height="18" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2l10 6-10 6V2z"/></svg>
					<svg class="icon-pause" width="18" height="18" viewBox="0 0 16 16" fill="currentColor" style="display:none"><path d="M3 2h4v12H3V2zm6 0h4v12H9V2z"/></svg>
				</button>
				<button id="btn-next" title="Hold Shift to skip entire segment">
					<svg class="icon-highlight" width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M6 2l6 6-6 6V2z"/></svg>
					<svg class="icon-segment" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" style="display:none"><path d="M11 3h2v10h-2V3zM3 3l6 5-6 5V3z"/></svg>
				</button>
			</div>

			<div class="audio-controls">
				<label class="control-row">
					<span class="label">Vol</span>
					<input type="range" id="volume-slider" min="0" max="100" value="80">
					<button id="btn-mute" title="Mute">&#128266;</button>
				</label>
				<label class="control-row">
					<span class="label">Speed</span>
					<div class="speed-buttons" id="speed-buttons">
						<button data-speed="1" class="active">1x</button>
						<button data-speed="1.25">1.25x</button>
						<button data-speed="1.5">1.5x</button>
						<button data-speed="2">2x</button>
					</div>
				</label>
				<label class="control-row">
					<span class="label">Voice</span>
					<select id="voice-select">
						<option value="af_heart">Heart (F)</option>
						<option value="af_bella">Bella (F)</option>
						<option value="af_sarah">Sarah (F)</option>
						<option value="am_adam">Adam (M)</option>
						<option value="am_michael">Michael (M)</option>
						<option value="bf_emma">Emma (BF)</option>
						<option value="bm_george">George (BM)</option>
					</select>
				</label>
			</div>

			<div class="explanation-box">
				<div id="explanation-text" class="explanation-text"></div>
			</div>

			<div class="agent-hint">
				<span class="agent-hint-icon">&#x1F4AC;</span>
				Have questions? Ask your coding agent!
			</div>
		</div>

		<div class="outline">
			<h3>Outline</h3>
			<ul id="outline-list"></ul>
		</div>
	</div>

	<div id="done-view" style="display:none;">
		<div class="done-card">
			<p class="done-text">Walkthrough complete</p>
			<p id="done-summary" class="done-summary"></p>
			<p class="done-hint">Have more questions? Ask your coding agent!</p>
			<button id="btn-restart" class="done-restart-btn">Restart Walkthrough</button>
		</div>
	</div>

	<script nonce="${nonce}" src="${audioUri}"></script>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}
}

function getNonce(): string {
	let text = "";
	const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}
