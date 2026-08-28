import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { Walkthrough } from "./walkthrough";
import { BrixServer } from "./server";
import { SidebarProvider } from "./sidebar";
import { WalkthroughStorage } from "./storage";
import { highlightRange, highlightSegmentRange, highlightSubRange, clearHighlights, disposeHighlights, enableSmoothScrolling, restoreSmoothScrolling, setHighlightTarget } from "./highlight";
import { streamTTS, isTTSAvailable, ensureServer, setWorkspaceRoot } from "./tts-bridge";
import { openDecisionsPanel, updateDecisionsPanel } from "./decisions-panel";
import { createNavigator } from "./navigator";
import { TheaterView } from "./theater";
import * as integrity from "./integrity";
import type { PlanIntegrity, PlanValidity } from "./integrity";
import type { AgentMessage, FromWebviewMessage, Segment, Highlight, Decision, FeedItem } from "./types";

// ── File-watcher fallback (backward compat) ──

const HIGHLIGHT_FILE = path.join(os.homedir(), ".claude-brix-highlight.json");

interface HighlightRequest {
	file: string;
	start: number;
	end: number;
}

// ── Workspace path containment ──
// Agent- and model-supplied file paths (segment.file, handoffPath, the
// highlight-file fallback) reach openTextDocument/readFile. Confine them to the
// workspace, resolving symlinks, so a hostile path can't open files elsewhere.

let guardRoot: string | undefined; // realpath'd workspace root

function setGuardRoot(ws: string | undefined): void {
	try { guardRoot = ws ? fs.realpathSync(ws) : undefined; }
	catch { guardRoot = ws; }
}

/** Absolute in-workspace path, or undefined if it escapes / doesn't exist / no workspace. */
function containedFile(p: string): string | undefined {
	if (!guardRoot || !p) return undefined;
	try {
		const abs = path.resolve(guardRoot, p);
		const real = fs.realpathSync(abs);
		if (real === guardRoot || real.startsWith(guardRoot + path.sep)) return abs;
	} catch {
		/* missing file or broken link */
	}
	return undefined;
}

let fileWatcher: fs.StatWatcher | undefined;

function startFileWatcher(): void {
	// Delete any stale highlight file from a previous session
	// instead of processing it — only react to NEW highlight requests
	try {
		fs.unlinkSync(HIGHLIGHT_FILE);
	} catch {}

	fileWatcher = fs.watchFile(
		HIGHLIGHT_FILE,
		{ interval: 300 },
		(curr, prev) => {
			if (curr.mtimeMs !== prev.mtimeMs) {
				processHighlightFile();
			}
		},
	);
}

function processHighlightFile(): void {
	let raw: string;
	try {
		raw = fs.readFileSync(HIGHLIGHT_FILE, "utf-8");
	} catch {
		return;
	}

	let request: HighlightRequest;
	try {
		request = JSON.parse(raw);
	} catch {
		return;
	}

	if (!request.file || typeof request.start !== "number" || typeof request.end !== "number") {
		return;
	}

	const safe = containedFile(request.file);
	if (!safe) return; // any local process can write this file — never open outside the workspace

	highlightRange(safe, request.start, request.end).catch((err) => {
		console.error("[brix] Fallback highlight failed:", err);
	});
}

// ── Continuous TTS plan ──

interface SegmentTTSPlan {
	fullText: string;
	/** chunkBoundaries[i] = index of first chunk belonging to the i-th spoken highlight */
	chunkBoundaries: number[];
	/** Maps each entry in chunkBoundaries back to the original highlight index (handles gaps from empty ttsText) */
	highlightIndices: number[];
	totalChunks: number;
}

function buildSegmentTTSPlan(highlights: Highlight[], startFrom = 0): SegmentTTSPlan {
	const SPLIT_RE = /(?<=[.!?])\s+/;
	const chunkBoundaries: number[] = [];
	const highlightIndices: number[] = [];
	const textParts: string[] = [];
	let totalChunks = 0;

	for (let i = startFrom; i < highlights.length; i++) {
		let text = (highlights[i].ttsText || "").trim();
		if (!text) continue;
		if (!/[.!?]$/.test(text)) text += ".";
		chunkBoundaries.push(totalChunks);
		highlightIndices.push(i);
		totalChunks += text.split(SPLIT_RE).filter(Boolean).length;
		textParts.push(text);
	}

	return { fullText: textParts.join(" "), chunkBoundaries, highlightIndices, totalChunks };
}

// ── Main activation ──

/** Any surface that can play narration audio (sidebar view or theater controls). */
interface PlaybackHost {
	sendAudioChunk(data: string, sampleRate: number): void;
	sendAudioEnd(): void;
	sendAudioStop(): void;
	sendAudioSuspend(): void;
	sendAudioResume(): void;
	waitForPlaybackComplete(): Promise<void>;
	setChunkPlayedCallback(cb: (() => void) | undefined): void;
}

function playHighlightChunk(
	segment: Segment,
	highlight: Highlight,
	highlightIndex: number,
	sidebar: PlaybackHost,
	voice: string,
	speed: number,
): { promise: Promise<void>; abort: () => void } {
	let abortFn: (() => void) | undefined;
	let aborted = false;

	const promise = new Promise<void>((resolve) => {
		highlightSubRange(segment.file, highlight.start, highlight.end, segment.highlights).catch(() => {});

		if (highlight.ttsText && isTTSAvailable()) {
			// Wait for the webview to signal actual playback completion,
			// not just the TTS server finishing its stream.
			sidebar.waitForPlaybackComplete().then(resolve);

			abortFn = streamTTS(
				highlight.ttsText,
				{ voice, speed },
				(base64, sampleRate) => {
					if (!aborted) sidebar.sendAudioChunk(base64, sampleRate);
				},
				() => {
					if (!aborted) sidebar.sendAudioEnd();
				},
				(err) => {
					console.error("[brix] TTS error:", err);
					resolve();
				},
			);
		} else {
			const timer = setTimeout(() => resolve(), 2000);
			abortFn = () => clearTimeout(timer);
		}
	});

	return {
		promise,
		abort: () => {
			aborted = true;
			if (abortFn) abortFn();
		},
	};
}

export function activate(context: vscode.ExtensionContext): void {
	// Set workspace root so TTS bridge can find venv Python
	const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (wsFolder) setWorkspaceRoot(wsFolder);
	setGuardRoot(wsFolder);

	/** Drop plan segments whose file points outside the workspace (see containedFile). */
	function sanitizeSegments(segs: Segment[]): Segment[] {
		if (!wsFolder) return segs; // no workspace → nothing to vouch against
		const safe = segs.filter((s) => containedFile(s.file));
		if (safe.length !== segs.length) {
			vscode.window.showWarningMessage(
				`Brix: dropped ${segs.length - safe.length} walkthrough segment(s) pointing outside the workspace.`,
			);
		}
		return safe;
	}

	const walkthrough = new Walkthrough();
	const sidebar = new SidebarProvider(context.extensionUri);
	const server = new BrixServer(walkthrough);
	const theater = new TheaterView(context.extensionUri);

	let storage: WalkthroughStorage | undefined;
	if (wsFolder) {
		storage = new WalkthroughStorage(wsFolder);
		server.setStorage(storage);
	}

	// Register sidebar
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, sidebar, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
	);

	// Initialize walkthrough-active context as false
	vscode.commands.executeCommand('setContext', 'brix.walkthroughActive', false);

	// ── Walkthrough freshness ──
	// Plans pin file:line ranges, so edits can point narration at the wrong code.
	let planIntegrity: PlanIntegrity | undefined;
	let planValidity: PlanValidity | undefined;

	async function captureIntegrity(): Promise<void> {
		const segs = walkthrough.getState().segments;
		if (segs.length === 0) { planIntegrity = undefined; planValidity = undefined; return; }
		planIntegrity = await integrity.capture(segs, wsFolder);
		planValidity = await integrity.validate(segs, planIntegrity, wsFolder);
		pushValidity();
	}

	/** Re-check the plan against disk; auto-relocate segments that merely moved. */
	async function revalidate(): Promise<void> {
		if (!planIntegrity) return;
		const segs = walkthrough.getState().segments;
		if (segs.length === 0) return;

		const result = await integrity.validate(segs, planIntegrity, wsFolder);

		// Apply pure line shifts so the walkthrough keeps working after edits above it.
		for (const seg of segs) {
			const v = result.segments[seg.id];
			if (v && v.state === "shifted") {
				walkthrough.replaceSegment(seg.id, integrity.shiftSegment(seg, v.delta));
			}
		}
		if (Object.values(result.segments).some((v) => v.state === "shifted")) {
			// re-anchor to the new positions so the shift isn't re-applied
			planIntegrity = await integrity.capture(walkthrough.getState().segments, wsFolder);
			planValidity = await integrity.validate(walkthrough.getState().segments, planIntegrity, wsFolder);
			// preserve the fact that something moved for the UI
			planValidity = { ...planValidity, overall: result.overall === "stale" ? "stale" : "shifted", segments: result.segments };
		} else {
			planValidity = result;
		}
		pushValidity();
	}

	function pushValidity(): void {
		sidebar.postMessage({ type: "validity", validity: planValidity ?? null });
		if (theater.isOpen()) theater.sendValidity(planValidity ?? null);
	}

	// ── Decision queue (human-in-the-loop) ──
	// ponytail: in-memory only — decisions are backed by handoff docs on disk,
	// so losing the card list on reload costs nothing durable.
	const decisions: Decision[] = [];
	server.setDecisionsProvider(() => decisions);
	// Freshness is computed on demand (when the agent calls `validate`), never
	// automatically on every edit — auto-recalc fired repeatedly during plan
	// execution and fought the agent's own in-flight writes.
	server.setValidityProvider(async () => {
		await revalidate();
		return planValidity ?? { overall: "unknown" };
	});

	/**
	 * Audio must play in the same webview the user clicked — an AudioContext
	 * only unlocks on a gesture in its own document. Theater controls win while
	 * visible; otherwise the sidebar hosts.
	 */
	let lastAudioHostWasTheater: boolean | undefined;
	function audioHost(): PlaybackHost {
		const useTheater = theater.isVisible();
		if (lastAudioHostWasTheater !== undefined && lastAudioHostWasTheater !== useTheater) {
			// Host switched: any "suspended audio" belongs to the old webview.
			hasSuspendedAudio = false;
		}
		lastAudioHostWasTheater = useTheater;
		return useTheater ? theater : sidebar;
	}

	/** The play loop's view of the world: audio goes to the host, UI to every surface. */
	function playbackSurface(): PlaybackHost & { updateState(s: ReturnType<Walkthrough["getState"]>): void } {
		const host = audioHost();
		return {
			sendAudioChunk: (d, r) => host.sendAudioChunk(d, r),
			sendAudioEnd: () => host.sendAudioEnd(),
			sendAudioStop: () => host.sendAudioStop(),
			sendAudioSuspend: () => host.sendAudioSuspend(),
			sendAudioResume: () => host.sendAudioResume(),
			waitForPlaybackComplete: () => host.waitForPlaybackComplete(),
			setChunkPlayedCallback: (cb) => host.setChunkPlayedCallback(cb),
			updateState: (st) => pushStateFrom(st),
		};
	}

	function pushStateFrom(st: ReturnType<Walkthrough["getState"]>): void {
		sidebar.updateState(st);
		if (theater.isOpen()) theater.update(st);
	}

	/** Push walkthrough state to every open surface. */
	function pushState(): void {
		sidebar.updateState(walkthrough.getState());
		if (theater.isOpen()) theater.update(walkthrough.getState());
	}

	/** Open theater mode: real editor centre, outline right, controls bottom. */
	async function openTheater(): Promise<void> {
		setHighlightTarget(vscode.ViewColumn.One, true);
		await theater.open(walkthrough.getState());
		sidebar.reveal(); // sidebar hosts audio playback; keep it resolved
	}

	/**
	 * Show the theater panels only while the active tab belongs to the
	 * walkthrough (a segment file, or one of our own panels). Anywhere else,
	 * hide them so the editor gets the full window back.
	 */
	let theaterSyncing = false;
	function syncTheaterVisibility(): void {
		if (!theater.isArmed() || theaterSyncing) return;

		const tab = vscode.window.tabGroups.activeTabGroup?.activeTab;
		const input = tab?.input as { viewType?: string; uri?: vscode.Uri } | undefined;
		let relevant = false;
		if (input && typeof input === "object") {
			if (typeof input.viewType === "string") {
				// our own outline/controls panels count as "on the walkthrough"
				relevant = input.viewType.includes("brix.");
			} else if (input.uri) {
				const files = new Set(walkthrough.getState().segments.map((seg) => seg.file));
				relevant = files.has(input.uri.fsPath);
			}
		}

		if (relevant === theater.isVisible()) return;
		theaterSyncing = true;
		const done = () => { theaterSyncing = false; };
		if (relevant) {
			theater.showAgain(walkthrough.getState()).then(done, done);
		} else {
			// The controls webview owns the audio while visible — disposing it
			// mid-narration would strand playback, so pause first.
			if (walkthrough.getState().status === "playing") {
				fullAudioStop();
				walkthrough.pause();
			}
			theater.hide();
			// let the layout settle before accepting more tab events
			setTimeout(done, 150);
		}
	}

	function closeTheater(): void {
		setHighlightTarget(undefined, false);
		theater.close();
	}

	function mirrorHighlightAdvance(_sb: unknown, index: number, total: number, explanation?: string): void {
		sidebar.sendHighlightAdvance(index, total, explanation);
		if (theater.isOpen()) theater.sendHighlightAdvance(index, total, explanation);
	}

	function pushDecisions(): void {
		sidebar.sendDecisions(decisions);
		updateDecisionsPanel(decisions);
	}

	function answerDecision(id: string, answer: string): void {
		const decision = decisions.find((d) => d.id === id);
		if (!decision || decision.status === "answered") return;
		decision.status = "answered";
		decision.answer = answer;
		pushDecisions();
		server.queueAction({
			type: "user_action",
			action: "decision_answered",
			decisionId: id,
			answer,
			handoffPath: decision.handoffPath,
		});
	}

	function openHandoff(relOrAbsPath: string): void {
		const abs = containedFile(relOrAbsPath);
		if (!abs) {
			vscode.window.showWarningMessage(`Brix: refusing to open a path outside the workspace: ${relOrAbsPath}`);
			return;
		}
		vscode.window.showTextDocument(vscode.Uri.file(abs), { preview: true }).then(undefined, () => {
			vscode.window.showWarningMessage(`Brix: handoff doc not found: ${relOrAbsPath}`);
		});
	}

	function showDecisionsPanel(): void {
		openDecisionsPanel(answerDecision, openHandoff, () => decisions);
	}

	// ── Distilled transcript feed + watched long-running tasks ──
	// ponytail: in-memory, capped — the terminal transcript is the full record;
	// this feed is the distilled view, losing it on reload costs nothing.
	const MAX_FEED_ITEMS = 200;
	const feed: FeedItem[] = [];
	const watchedTasks = new Map<string, { title: string; timer: ReturnType<typeof setInterval> }>();
	let feedIdCounter = 0;

	function pushFeed(): void {
		sidebar.sendFeed(feed);
	}

	function addFeedItem(item: { id?: string; kind: FeedItem["kind"]; title: string; body?: string; source?: string }): void {
		feed.unshift({
			id: item.id || `f${++feedIdCounter}`,
			kind: item.kind,
			title: item.title,
			body: item.body,
			source: item.source,
			ts: Date.now(),
		});
		if (feed.length > MAX_FEED_ITEMS) feed.length = MAX_FEED_ITEMS;
		pushFeed();
	}

	function endWatchedTask(id: string): void {
		const task = watchedTasks.get(id);
		if (task) {
			clearInterval(task.timer);
			watchedTasks.delete(id);
		}
	}

	// Start file-watcher fallback
	startFileWatcher();

	// Start HTTP+WS server
	server.start().then((port) => {
		console.log(`[brix] Server listening on port ${port}`);
	});

	// ── Walkthrough events → sidebar + highlights ──

	// TTS settings — updated by webview messages
	let ttsVoice = "af_heart";
	let ttsSpeed = 1;
	let walkthroughSaved = false;

	let currentChunkAbort: (() => void) | undefined;
	let highlightLoopGeneration = 0;
	// When navigating prev_highlight across segment boundary, we want to start
	// from the last highlight of the previous segment instead of the default 0.
	let pendingHighlightStart: number | undefined;
	// True when audio was suspended (not stopped) during pause — allows exact-position resume
	let hasSuspendedAudio = false;

	/** Stop audio and reset suspended flag. Use this instead of sidebar.sendAudioStop() directly. */
	function fullAudioStop(): void {
		audioHost().sendAudioStop();
		audioHost().setChunkPlayedCallback(undefined);
		hasSuspendedAudio = false;
	}

	/**
	 * Resume from suspended audio — just unpause the AudioContext.
	 * The original playSegmentHighlights loop is still alive (paused at `await playbackDone`)
	 * with its chunkPlayedCallback intact, so highlights will continue advancing
	 * as the buffered audio plays out.
	 */
	function resumeFromSuspended(): void {
		hasSuspendedAudio = false;
		audioHost().sendAudioResume();
	}

	/** Pre-warm the TTS server then resume playback from a specific highlight index. */
	function preWarmAndResume(startHighlight: number): void {
		const seg = walkthrough.getCurrentSegment();
		if (!seg) return;
		highlightLoopGeneration++;
		if (currentChunkAbort) { currentChunkAbort(); currentChunkAbort = undefined; }
		fullAudioStop();
		sidebar.sendServerLoading(true); theater.sendServerLoading(true);
		const segId = seg.id;
		ensureServer().then(() => {
			sidebar.sendServerLoading(false); theater.sendServerLoading(false);
			// Guard: segment may have changed while server was warming up
			if (walkthrough.getCurrentSegment()?.id !== segId) return;
			if (walkthrough.getState().status === "playing") {
				playSegmentHighlights(seg, walkthrough, playbackSurface(), startHighlight).catch((err) => {
					console.error("[brix] Highlight loop error:", err);
				});
			}
		}).catch((err) => {
			sidebar.sendServerLoading(false); theater.sendServerLoading(false);
			console.error("[brix] ensureServer failed:", err);
		});
	}

	async function playSegmentHighlights(
		segment: Segment,
		wt: Walkthrough,
		sb: PlaybackHost & { updateState(s: ReturnType<Walkthrough["getState"]>): void },
		startFromHighlight = 0,
	): Promise<void> {
		const myGeneration = ++highlightLoopGeneration;

		const highlights = segment.highlights;

		// If not playing, just show the code location without starting TTS
		if (wt.getState().status !== "playing") {
			await highlightSegmentRange(segment.file, segment.start, segment.end).catch(() => {});
			sb.updateState(wt.getState());
			if (theater.isOpen()) theater.update(wt.getState());
			return;
		}

		await highlightSegmentRange(segment.file, segment.start, segment.end).catch(() => {});
		sb.updateState(wt.getState());
		if (theater.isOpen()) theater.update(wt.getState());

		// ── Continuous TTS path: one call per segment ──
		const hasTTS = isTTSAvailable() && highlights.some((h) => h.ttsText);
		if (hasTTS) {
			const plan = buildSegmentTTSPlan(highlights, startFromHighlight);
			if (plan.fullText && plan.chunkBoundaries.length > 0) {
				// Show first highlight immediately
				const firstHighlightIdx = plan.highlightIndices[0] ?? startFromHighlight;
				wt.setHighlightIndex(firstHighlightIdx);
				mirrorHighlightAdvance(sb, firstHighlightIdx, highlights.length, highlights[firstHighlightIdx].explanation);
				await highlightSubRange(segment.file, highlights[firstHighlightIdx].start, highlights[firstHighlightIdx].end, highlights).catch(() => {});

				// Track played chunks (from webview onended) to advance pointer at playback speed
				let playedChunks = 0;
				let pointerOffset = 0;

				sb.setChunkPlayedCallback(() => {
					if (myGeneration !== highlightLoopGeneration) return;
					playedChunks++;

					const nextPointer = pointerOffset + 1;
					if (
						nextPointer < plan.chunkBoundaries.length &&
						playedChunks >= plan.chunkBoundaries[nextPointer]
					) {
						pointerOffset = nextPointer;
						const highlightIdx = plan.highlightIndices[nextPointer];
						if (highlightIdx !== undefined && highlightIdx < highlights.length) {
							wt.setHighlightIndex(highlightIdx);
							mirrorHighlightAdvance(sb, highlightIdx, highlights.length, highlights[highlightIdx].explanation);
							highlightSubRange(segment.file, highlights[highlightIdx].start, highlights[highlightIdx].end, highlights).catch(() => {});
						}
					}
				});

				const playbackDone = sb.waitForPlaybackComplete();

				const abortTTS = streamTTS(
					plan.fullText,
					{ voice: ttsVoice, speed: ttsSpeed },
					(base64, sampleRate) => {
						if (myGeneration !== highlightLoopGeneration) return;
						sb.sendAudioChunk(base64, sampleRate);
					},
					() => {
						if (myGeneration !== highlightLoopGeneration) return;
						sb.sendAudioEnd();
					},
					(err) => {
						console.error("[brix] TTS error:", err);
					},
				);

				currentChunkAbort = abortTTS;
				await playbackDone;
				currentChunkAbort = undefined;
				sb.setChunkPlayedCallback(undefined);

				if (myGeneration !== highlightLoopGeneration) return;

				// All highlights done — auto-advance to next segment
				if (wt.getState().status === "playing") {
					wt.next();
				}
				return;
			}
		}

		// ── Fallback: per-highlight TTS (no TTS available or no ttsText) ──
		for (let i = startFromHighlight; i < highlights.length; i++) {
			if (myGeneration !== highlightLoopGeneration) return;

			wt.setHighlightIndex(i);
			mirrorHighlightAdvance(sb, i, highlights.length, highlights[i].explanation);

			const chunk = playHighlightChunk(
				segment,
				highlights[i],
				i,
				sb,
				ttsVoice,
				ttsSpeed,
			);
			currentChunkAbort = chunk.abort;

			await chunk.promise;
			currentChunkAbort = undefined;

			if (myGeneration !== highlightLoopGeneration) return;
		}

		// All highlights done — auto-advance to next segment
		if (myGeneration === highlightLoopGeneration && wt.getState().status === "playing") {
			wt.next();
		}
	}

	walkthrough.on("segment", (segment: Segment) => {
		// Enable smooth scrolling for the walkthrough
		enableSmoothScrolling().catch(() => {});

		// Increment generation to invalidate any in-flight highlight loop
		highlightLoopGeneration++;
		if (currentChunkAbort) {
			currentChunkAbort();
			currentChunkAbort = undefined;
		}
		fullAudioStop();

		const startIdx = pendingHighlightStart ?? 0;
		pendingHighlightStart = undefined;
		playSegmentHighlights(segment, walkthrough, playbackSurface(), startIdx).catch((err) => {
			console.error("[brix] Highlight loop error:", err);
		});
	});

	walkthrough.on("plan", () => {
		pushState();
		server.broadcastState();
		vscode.commands.executeCommand('setContext', 'brix.walkthroughActive', true);
	});

	walkthrough.on("status", () => {
		pushState();
		server.broadcastState();

		const state = walkthrough.getState();
		if (state.status === "paused" || state.status === "stopped") {
			if (currentChunkAbort) {
				currentChunkAbort();
				currentChunkAbort = undefined;
			}
			if (state.status === "paused") {
				// Suspend audio but keep the highlight loop alive — don't
				// increment highlightLoopGeneration so the chunkPlayedCallback
				// remains valid and can advance highlights when audio resumes.
				audioHost().sendAudioSuspend();
				hasSuspendedAudio = true;
			} else {
				highlightLoopGeneration++;
			}
		}

		if (state.status === "stopped") {
			hasSuspendedAudio = false;
			closeTheater();
			clearHighlights();
			restoreSmoothScrolling().catch(() => {});
			vscode.commands.executeCommand('setContext', 'brix.walkthroughActive', false);
		}
	});

	// ── Keybinding command registrations ──

	const speedPresets = [0.75, 1, 1.25, 1.5, 2];

	context.subscriptions.push(
		vscode.commands.registerCommand('brix.togglePlayPause', () => {
			walkthrough.togglePlayPause();
			if (walkthrough.getState().status === "playing") {
				if (hasSuspendedAudio) {
					resumeFromSuspended();
				} else {
					preWarmAndResume(walkthrough.getHighlightIndex());
				}
			}
		}),
		vscode.commands.registerCommand('brix.next', () => {
			const seg = walkthrough.getCurrentSegment();
			if (seg?.highlights && seg.highlights.length > 0) {
				const curIdx = walkthrough.getHighlightIndex();
				if (curIdx >= seg.highlights.length - 1) return;
				const nextIdx = curIdx + 1;
				highlightLoopGeneration++;
				if (currentChunkAbort) { currentChunkAbort(); currentChunkAbort = undefined; }
				fullAudioStop();
				walkthrough.setHighlightIndex(nextIdx);
				if (walkthrough.getState().status === "playing") {
					playSegmentHighlights(seg, walkthrough, playbackSurface(), nextIdx).catch((err) => {
						console.error("[brix] Highlight loop error:", err);
					});
				} else {
					mirrorHighlightAdvance(sidebar, nextIdx, seg.highlights.length);
					highlightSubRange(seg.file, seg.highlights[nextIdx].start, seg.highlights[nextIdx].end).catch(() => {});
				}
			}
		}),
		vscode.commands.registerCommand('brix.prev', () => {
			const seg = walkthrough.getCurrentSegment();
			if (seg?.highlights && seg.highlights.length > 0) {
				const curIdx = walkthrough.getHighlightIndex();
				if (curIdx <= 0) return;
				const prevIdx = curIdx - 1;
				highlightLoopGeneration++;
				if (currentChunkAbort) { currentChunkAbort(); currentChunkAbort = undefined; }
				fullAudioStop();
				walkthrough.setHighlightIndex(prevIdx);
				if (walkthrough.getState().status === "playing") {
					playSegmentHighlights(seg, walkthrough, playbackSurface(), prevIdx).catch((err) => {
						console.error("[brix] Highlight loop error:", err);
					});
				} else {
					mirrorHighlightAdvance(sidebar, prevIdx, seg.highlights.length);
					highlightSubRange(seg.file, seg.highlights[prevIdx].start, seg.highlights[prevIdx].end).catch(() => {});
				}
			}
		}),
		vscode.commands.registerCommand('brix.nextSegment', () => {
			if (currentChunkAbort) { currentChunkAbort(); currentChunkAbort = undefined; }
			fullAudioStop();
			walkthrough.next();
		}),
		vscode.commands.registerCommand('brix.prevSegment', () => {
			if (currentChunkAbort) { currentChunkAbort(); currentChunkAbort = undefined; }
			fullAudioStop();
			walkthrough.prev();
		}),
		vscode.commands.registerCommand('brix.stop', () => {
			fullAudioStop();
			walkthrough.stop();
		}),
		vscode.commands.registerCommand('brix.speedUp', () => {
			const currentIdx = speedPresets.indexOf(ttsSpeed);
			const idx = currentIdx === -1 ? 1 : currentIdx;
			const nextIdx = Math.min(idx + 1, speedPresets.length - 1);
			ttsSpeed = speedPresets[nextIdx];
			vscode.window.setStatusBarMessage(`Speed: ${ttsSpeed}x`, 2000);
		}),
		vscode.commands.registerCommand('brix.speedDown', () => {
			const currentIdx = speedPresets.indexOf(ttsSpeed);
			const idx = currentIdx === -1 ? 1 : currentIdx;
			const nextIdx = Math.max(idx - 1, 0);
			ttsSpeed = speedPresets[nextIdx];
			vscode.window.setStatusBarMessage(`Speed: ${ttsSpeed}x`, 2000);
		}),
		vscode.commands.registerCommand('brix.saveWalkthrough', async () => {
			if (!storage) {
				vscode.window.showErrorMessage("No workspace folder open");
				return;
			}
			const state = walkthrough.getState();
			if (state.segments.length === 0) {
				vscode.window.showWarningMessage("No active walkthrough to save");
				return;
			}
			const defaultName = WalkthroughStorage.slugify(state.title);
			const name = await vscode.window.showInputBox({
				prompt: "Walkthrough name",
				value: defaultName,
				validateInput: (v) => v.trim() ? null : "Name cannot be empty",
			});
			if (!name) return;
			if (await storage.exists(name)) {
				const overwrite = await vscode.window.showWarningMessage(
					`"${name}" already exists. Overwrite?`,
					"Overwrite", "Cancel"
				);
				if (overwrite !== "Overwrite") return;
			}
			await storage.save(state.title, state.segments, name);
			walkthroughSaved = true;
			vscode.window.showInformationMessage(`Walkthrough saved to .walkthroughs/${name}.json`);
		}),
		vscode.commands.registerCommand('brix.openTheater', () => {
			openTheater().catch((err) => console.error("[brix] theater open failed:", err));
		}),
		vscode.commands.registerCommand('brix.openDecisions', () => {
			showDecisionsPanel();
		}),
		vscode.commands.registerCommand('brix.loadWalkthrough', async () => {
			if (!storage) {
				vscode.window.showErrorMessage("No workspace folder open");
				return;
			}
			const items = await storage.list();
			if (items.length === 0) {
				vscode.window.showInformationMessage("No saved walkthroughs found in .walkthroughs/");
				return;
			}
			const pick = await vscode.window.showQuickPick(
				items.map((item) => ({
					label: item.title,
					description: item.name,
				})),
				{ placeHolder: "Select a walkthrough to load" }
			);
			if (!pick) return;
			const data = await storage.load(pick.description!);
			if (!data) {
				vscode.window.showErrorMessage("Failed to load walkthrough");
				return;
			}
			walkthrough.setPlan(data.title, data.segments);
			sidebar.reveal();
		}),
	);

	// ── Agent messages → walkthrough state ──
	// Extracted to a named function so the in-process navigator can dispatch the
	// same messages the HTTP bus carries (inheriting auto-save, theater, integrity).

	const dispatch = (msg: AgentMessage): void => {
		switch (msg.type) {
			case "set_plan": {
				walkthroughSaved = false;
				const planSegments = sanitizeSegments(msg.segments);
				walkthrough.setPlan(msg.title, planSegments);
				sidebar.reveal();
				// Auto-save so the sidebar's recents list is always populated.
				storage?.save(msg.title, planSegments, undefined, planIntegrity).then(() => {
					sidebar.postMessage({ type: "saved_list", walkthroughs: [] });
					return storage?.list();
				}).then((list) => {
					if (list) sidebar.postMessage({
						type: "saved_list",
						walkthroughs: list.slice(0, 5).map(({ name, title }) => ({ name, title })),
					});
				}).catch(() => {});
				openTheater().catch((err) => console.error("[brix] theater open failed:", err));
				captureIntegrity().catch(() => {});
				break;
			}
			case "insert_after":
				walkthrough.insertAfter(msg.afterSegment, sanitizeSegments(msg.segments));
				break;
			case "replace_segment": {
				const [safe] = sanitizeSegments([msg.segment]);
				if (safe) walkthrough.replaceSegment(msg.id, safe);
				break;
			}
			case "remove_segments":
				walkthrough.removeSegments(msg.ids);
				break;
			case "goto":
				walkthrough.navigateTo(msg.segmentId);
				break;
			case "resume": {
				const resumeHighlightIdx = walkthrough.getHighlightIndex();
				walkthrough.play();
				if (hasSuspendedAudio) {
					resumeFromSuspended();
				} else {
					preWarmAndResume(resumeHighlightIdx);
				}
				break;
			}
			case "stop":
				fullAudioStop();
				walkthrough.stop();
				break;
			case "raise_decision": {
				const existing = decisions.find((d) => d.id === msg.decision.id);
				if (existing) {
					Object.assign(existing, msg.decision, { status: "open" as const, answer: undefined });
				} else {
					decisions.unshift({ ...msg.decision, status: "open", raisedAt: Date.now() });
				}
				pushDecisions();
				sidebar.reveal();
				vscode.window
					.showInformationMessage(`Brix — decision needed: ${msg.decision.title}`, "Open Brix")
					.then((choice) => { if (choice) sidebar.reveal(); });
				break;
			}
			case "resolve_decision": {
				const idx = decisions.findIndex((d) => d.id === msg.id);
				if (idx !== -1) {
					if (msg.answer !== undefined) {
						decisions[idx].status = "answered";
						decisions[idx].answer = msg.answer;
					} else {
						decisions.splice(idx, 1);
					}
					pushDecisions();
				}
				break;
			}
			case "post_update":
				addFeedItem(msg.item);
				break;
			case "watch_task": {
				endWatchedTask(msg.id); // re-watching resets the timer
				const intervalMs = Math.max(60, msg.intervalSec ?? 300) * 1000;
				const timer = setInterval(() => {
					server.queueStatusRequest(msg.id, msg.title);
				}, intervalMs);
				watchedTasks.set(msg.id, { title: msg.title, timer });
				addFeedItem({
					kind: "progress",
					title: `Watching: ${msg.title}`,
					body: `Status updates every ${Math.round(intervalMs / 60000)} min while this runs.`,
					source: `task:${msg.id}`,
				});
				break;
			}
			case "end_task": {
				const task = watchedTasks.get(msg.id);
				endWatchedTask(msg.id);
				addFeedItem({
					kind: "status",
					title: task ? `Done: ${task.title}` : `Done: ${msg.id}`,
					body: msg.summary,
					source: `task:${msg.id}`,
				});
				break;
			}
			case "ask": {
				// A question about the current step from any source (voice daemon,
				// script). Route to the navigator, or to the driver agent if it's off.
				const seg = walkthrough.getCurrentSegment();
				const segmentId = seg ? seg.id : -1;
				if (navigator.isConfigured()) {
					navigator.ask(msg.question, segmentId);
				} else {
					server.queueAction({ type: "user_action", action: "ask_question", segmentId, question: msg.question });
					addFeedItem({ kind: "info", title: "Question sent to your coding agent", body: msg.question });
				}
				break;
			}
		}
	};
	server.setMessageHandler(dispatch);

	// ── Navigator: brix-hosted pair partner ──

	const navigator = createNavigator(context, {
		dispatch,
		addFeedItem,
		getWalkthrough: () => walkthrough.getState(),
		captureIntegrity,
		prewarmTTS: () => { ensureServer().catch(() => {}); },
		wsFolder,
	});

	context.subscriptions.push(
		vscode.commands.registerCommand("brix.navigatorReviewDiff", () => navigator.reviewDiff()),
		vscode.commands.registerCommand("brix.setNavigatorKey", async () => {
			const value = await vscode.window.showInputBox({
				password: true,
				prompt: "Navigator API key (leave empty to clear)",
			});
			if (value === undefined) return;
			if (value === "") {
				await context.secrets.delete("brix.navigator.apiKey");
				vscode.window.showInformationMessage("Brix: navigator API key cleared");
			} else {
				await context.secrets.store("brix.navigator.apiKey", value);
				vscode.window.showInformationMessage("Brix: navigator API key saved");
			}
		}),
	);

	// ── Webview messages → walkthrough state + server ──

	const handleWebviewMessage = async (msg: FromWebviewMessage): Promise<void> => {
		switch (msg.type) {
			case "play_pause":
				walkthrough.togglePlayPause();
				// If resuming, try to resume suspended audio first for exact-position resume
				if (walkthrough.getState().status === "playing") {
					if (hasSuspendedAudio) {
						resumeFromSuspended();
					} else {
						preWarmAndResume(walkthrough.getHighlightIndex());
					}
				}
				break;
			case "next_highlight": {
				const seg = walkthrough.getCurrentSegment();
				if (seg?.highlights && seg.highlights.length > 0) {
					const curIdx = walkthrough.getHighlightIndex();
					if (curIdx >= seg.highlights.length - 1) {
						// At last sub-segment — advance to next segment's first highlight
						const nextSegIdx = walkthrough.getState().currentIndex + 1;
						if (nextSegIdx >= walkthrough.getState().segments.length) break; // At walkthrough end
						if (currentChunkAbort) { currentChunkAbort(); currentChunkAbort = undefined; }
								fullAudioStop();
						walkthrough.next(); // emits "segment" → starts from highlight 0
						break;
					}
					const nextIdx = curIdx + 1;
					highlightLoopGeneration++;
					if (currentChunkAbort) { currentChunkAbort(); currentChunkAbort = undefined; }
					fullAudioStop();
					walkthrough.setHighlightIndex(nextIdx);
					if (walkthrough.getState().status === "playing") {
						playSegmentHighlights(seg, walkthrough, playbackSurface(), nextIdx).catch((err) => {
							console.error("[brix] Highlight loop error:", err);
						});
					} else {
						mirrorHighlightAdvance(sidebar, nextIdx, seg.highlights.length, seg.highlights[nextIdx].explanation);
						highlightSubRange(seg.file, seg.highlights[nextIdx].start, seg.highlights[nextIdx].end, seg.highlights).catch(() => {});
					}
				}
				break;
			}
			case "prev_highlight": {
				const seg = walkthrough.getCurrentSegment();
				if (seg?.highlights && seg.highlights.length > 0) {
					const curIdx = walkthrough.getHighlightIndex();
					if (curIdx <= 0) {
						// At first sub-segment — go to previous segment's last highlight
						const wtState = walkthrough.getState();
						const prevSegIdx = wtState.currentIndex - 1;
						if (prevSegIdx < 0) break; // Already at the very first segment
						const prevSeg = wtState.segments[prevSegIdx];
						const prevHighlightCount = prevSeg?.highlights?.length ?? 0;
						if (prevHighlightCount > 0) {
							pendingHighlightStart = prevHighlightCount - 1;
						}
						if (currentChunkAbort) { currentChunkAbort(); currentChunkAbort = undefined; }
								fullAudioStop();
						walkthrough.prev(); // emits "segment" → pendingHighlightStart used
						break;
					}
					const prevIdx = curIdx - 1;
					highlightLoopGeneration++;
					if (currentChunkAbort) { currentChunkAbort(); currentChunkAbort = undefined; }
					fullAudioStop();
					walkthrough.setHighlightIndex(prevIdx);
					if (walkthrough.getState().status === "playing") {
						playSegmentHighlights(seg, walkthrough, playbackSurface(), prevIdx).catch((err) => {
							console.error("[brix] Highlight loop error:", err);
						});
					} else {
						mirrorHighlightAdvance(sidebar, prevIdx, seg.highlights.length, seg.highlights[prevIdx].explanation);
						highlightSubRange(seg.file, seg.highlights[prevIdx].start, seg.highlights[prevIdx].end, seg.highlights).catch(() => {});
					}
				}
				break;
			}
			case "next":
				if (currentChunkAbort) { currentChunkAbort(); currentChunkAbort = undefined; }
				fullAudioStop();
				walkthrough.next();
				break;
			case "prev":
				if (currentChunkAbort) { currentChunkAbort(); currentChunkAbort = undefined; }
				fullAudioStop();
				walkthrough.prev();
				break;
			case "goto_segment":
				if (currentChunkAbort) { currentChunkAbort(); currentChunkAbort = undefined; }
				fullAudioStop();
				walkthrough.goto(msg.segmentId);
				break;
			case "speed_change":
				ttsSpeed = msg.speed;
				break;
			case "volume_change":
				// Audio lives in the sidebar webview; relay theater changes to it.
				sidebar.postMessage({ type: "set_volume", volume: msg.volume });
				break;
			case "voice_change":
				ttsVoice = msg.voice;
				break;
			case "mute_toggle":
				// Mute is handled in webview's Web Audio GainNode
				break;
			case "restart": {
				if (currentChunkAbort) { currentChunkAbort(); currentChunkAbort = undefined; }
				fullAudioStop();
				const segments = walkthrough.getState().segments;
				if (segments.length > 0) {
					walkthrough.goto(segments[0].id);
				}
				break;
			}
			case "save":
				vscode.commands.executeCommand('brix.saveWalkthrough');
				break;
			case "load":
				if (storage) {
					const data = await storage.load(msg.name);
					if (data) {
						walkthroughSaved = true;
						walkthrough.setPlan(data.title, data.segments);
						sidebar.reveal();
						await openTheater();
						// A saved snapshot tells us whether the code moved since it was made.
						if (data.integrity) {
							planIntegrity = data.integrity as PlanIntegrity;
							await revalidate();
						} else {
							await captureIntegrity();
						}
					}
				}
				break;
			case "request_saved_list":
				if (storage) {
					const list = await storage.list();
					sidebar.postMessage({
						type: "saved_list",
						walkthroughs: list.slice(0, 5).map(({ name, title }) => ({ name, title })),
					});
				}
				break;
			case "decision_answer":
				answerDecision(msg.id, msg.answer);
				break;
			case "ask_navigator":
				if (navigator.isConfigured()) {
					navigator.ask(msg.question, msg.segmentId);
				} else {
					// no navigator → route to the external driver agent's long-poll
					server.queueAction({
						type: "user_action",
						action: "ask_question",
						segmentId: msg.segmentId,
						question: msg.question,
					});
					addFeedItem({ kind: "info", title: "Question sent to your coding agent", body: msg.question });
				}
				break;
			case "open_handoff":
				openHandoff(msg.path);
				break;
			case "open_decisions_panel":
				showDecisionsPanel();
				break;
			case "open_theater":
				await openTheater();
				break;
			case "request_decisions":
				pushDecisions();
				break;
			case "request_feed":
				pushFeed();
				break;
			case "clear_feed":
				feed.length = 0;
				pushFeed();
				break;
			case "close_walkthrough": {
				const wtState = walkthrough.getState();
				if (wtState.status !== "idle" && wtState.status !== "stopped" && !walkthroughSaved) {
					const choice = await vscode.window.showWarningMessage(
						"This walkthrough hasn't been saved. Close anyway?",
						{ modal: true, detail: "You can re-generate it by asking your coding agent to send the walkthrough again." },
						"Save & Close",
						"Close Without Saving",
					);
					if (!choice) break; // dismissed
					if (choice === "Save & Close") {
						await vscode.commands.executeCommand('brix.saveWalkthrough');
					}
				}
				if (currentChunkAbort) { currentChunkAbort(); currentChunkAbort = undefined; }
				fullAudioStop();
				walkthrough.stop();
				walkthroughSaved = false;
				closeTheater();
				break;
			}
		}
	};

	sidebar.setMessageHandler(handleWebviewMessage);
	theater.setMessageHandler((msg) => { handleWebviewMessage(msg); });

	// A walkthrough goes stale when its files change underneath it, but we no
	// longer recompute automatically on every edit — that fired repeatedly while
	// a plan was being executed. Freshness is now pull-based: the agent calls
	// `brix.sh validate`, which recomputes via the validity provider above.

	// Keep theater panels in step with the active tab
	context.subscriptions.push(
		vscode.window.tabGroups.onDidChangeTabs(() => syncTheaterVisibility()),
		vscode.window.tabGroups.onDidChangeTabGroups(() => syncTheaterVisibility()),
	);

	// ── Cleanup ──

	context.subscriptions.push({
		dispose: () => {
			for (const id of Array.from(watchedTasks.keys())) endWatchedTask(id);
			server.stop();
			if (fileWatcher) {
				fs.unwatchFile(HIGHLIGHT_FILE);
				fileWatcher = undefined;
			}
			restoreSmoothScrolling().catch(() => {});
			disposeHighlights();
		},
	});
}

export function deactivate(): void {}
