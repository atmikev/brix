// @ts-check

/** @type {ReturnType<typeof acquireVsCodeApi>} */
const vscode = acquireVsCodeApi();

// ── State ──

let state = {
	title: "",
	segments: [],
	currentSegment: -1,
	status: "idle",
};

// ── UI rendering ──

function showDoneView() {
	document.getElementById("idle-view").style.display = "none";
	document.getElementById("active-view").style.display = "none";
	document.getElementById("done-view").style.display = "";
	document.getElementById("done-summary").textContent =
		`${state.segments.length} segments covered`;
}

function render() {
	const idleView = document.getElementById("idle-view");
	const activeView = document.getElementById("active-view");
	const doneView = document.getElementById("done-view");

	if (state.status === "idle") {
		idleView.style.display = "";
		activeView.style.display = "none";
		doneView.style.display = "none";
		vscode.postMessage({ type: "request_saved_list" });
		return;
	}

	if (state.status === "stopped") {
		idleView.style.display = "";
		activeView.style.display = "none";
		doneView.style.display = "none";
		vscode.postMessage({ type: "request_saved_list" });
		return;
	}

	idleView.style.display = "none";
	activeView.style.display = "";
	doneView.style.display = "none";

	// Title
	document.getElementById("walkthrough-title").textContent = state.title;

	// Now playing
	const seg = state.segments.find((s) => s.id === state.currentSegment);
	const idx = state.segments.findIndex((s) => s.id === state.currentSegment);

	if (seg) {
		document.getElementById("segment-title").textContent = seg.title;

		const loc = document.getElementById("segment-location");
		const fileName = seg.file.split("/").pop();
		loc.textContent = `${fileName}:${seg.start}-${seg.end}`;
		loc.dataset.file = seg.file;
		loc.dataset.start = String(seg.start);
		loc.dataset.end = String(seg.end);
	}

	// Play/pause button (SVG icon toggle)
	const playBtn = document.getElementById("btn-play-pause");
	const iconPlay = playBtn.querySelector(".icon-play");
	const iconPause = playBtn.querySelector(".icon-pause");
	if (state.status === "playing") {
		iconPlay.style.display = "none";
		iconPause.style.display = "";
	} else {
		iconPlay.style.display = "";
		iconPause.style.display = "none";
	}
	playBtn.title = state.status === "playing" ? "Pause" : "Play";

	// Pulse animation when paused (ready to play)
	if (state.status === "paused") {
		playBtn.classList.add("pulse");
	} else {
		playBtn.classList.remove("pulse");
	}

	// Explanation with fade transition
	if (seg) {
		const explEl = document.getElementById("explanation-text");
		explEl.classList.add("fade-out");
		setTimeout(() => {
			explEl.innerHTML = simpleMarkdown(seg.explanation);
			explEl.classList.remove("fade-out");
		}, 150);
	}

	// Outline
	renderOutline(idx);
}

function computeGlobalProgress() {
	if (state.segments.length === 0) {
		return { current: 0, total: 0 };
	}
	let totalGlobalHighlights = 0;
	let completedHighlights = 0;
	const currentIdx = state.segments.findIndex(s => s.id === state.currentSegment);

	for (let i = 0; i < state.segments.length; i++) {
		const seg = state.segments[i];
		const segHighlights = (seg.highlights && seg.highlights.length > 0) ? seg.highlights.length : 1;
		totalGlobalHighlights += segHighlights;

		if (i < currentIdx) {
			completedHighlights += segHighlights;
		} else if (i === currentIdx) {
			completedHighlights += currentHighlightIndex;
		}
	}

	return { current: completedHighlights + 1, total: totalGlobalHighlights };
}

function renderHighlightProgress() {
	const counter = document.getElementById("segment-counter");
	if (!counter) return;

	const { current, total } = computeGlobalProgress();
	if (total > 0) {
		counter.textContent = `${current}/${total}`;
	} else {
		counter.textContent = "";
	}

	// Update progress bar
	const progressFill = document.getElementById("progress-fill");
	if (progressFill && total > 0) {
		const pct = (current / total) * 100;
		progressFill.style.width = `${pct}%`;
	}

	// Update nav button icons based on current highlight count
	updateNavIcons();
}

/** Track segment IDs used for the last full outline build */
let outlineSegmentIds = [];

function renderOutline(currentIdx) {
	const list = document.getElementById("outline-list");

	const currentIds = state.segments.map(s => s.id);
	const needsRebuild = currentIds.length !== outlineSegmentIds.length ||
		currentIds.some((id, i) => id !== outlineSegmentIds[i]);

	if (needsRebuild) {
		list.innerHTML = "";
		outlineSegmentIds = currentIds;

		for (let i = 0; i < state.segments.length; i++) {
			const seg = state.segments[i];
			const li = document.createElement("li");
			li.className = "outline-segment";

			// Segment header (clickable)
			const header = document.createElement("div");
			header.className = "outline-segment-header";

			const marker = document.createElement("span");
			marker.className = "marker";

			const text = document.createElement("span");
			text.className = "segment-label";
			text.textContent = `${i + 1}. ${seg.title}`;

			const progress = document.createElement("span");
			progress.className = "segment-progress";

			header.appendChild(marker);
			header.appendChild(text);
			header.appendChild(progress);

			// Clicking header navigates to segment
			header.addEventListener("pointerdown", (e) => {
				e.preventDefault();
				vscode.postMessage({ type: "goto_segment", segmentId: seg.id });
			});

			li.appendChild(header);
			list.appendChild(li);
		}
	}

	// Update state classes
	const items = list.children;
	for (let i = 0; i < items.length; i++) {
		const li = items[i];
		const header = li.querySelector(".outline-segment-header");

		if (i === currentIdx) {
			header.className = "outline-segment-header current";
		} else if (i < currentIdx) {
			header.className = "outline-segment-header completed";
		} else {
			header.className = "outline-segment-header";
		}

		const marker = li.querySelector(".marker");
		if (i < currentIdx) marker.textContent = "\u2713";
		else if (i === currentIdx) marker.textContent = "\u25B6";
		else marker.textContent = "\u25CB";

		// Update segment progress fraction
		const progress = li.querySelector(".segment-progress");
		const seg = state.segments[i];
		const segTotal = (seg.highlights && seg.highlights.length > 0) ? seg.highlights.length : 1;
		// For the current segment, prefer totalHighlights from highlight_advance
		const total = (i === currentIdx && totalHighlights > 0) ? totalHighlights : segTotal;
		if (total > 1) {
			let completed;
			if (i < currentIdx) completed = total;
			else if (i === currentIdx) completed = currentHighlightIndex + 1;
			else completed = 0;
			progress.textContent = `${completed}/${total}`;
		} else {
			progress.textContent = "";
		}
	}
}

// ── Decisions (human-in-the-loop) ──

/** @type {Array<any>} */
let decisions = [];

/** ids currently shown as open — lets us animate their departure once answered */
const seenOpenDecisions = new Set();
/** id -> timestamp when it was first observed answered */
const departingDecisions = new Map();
/** total lifetime of an answered card: confirmation hold + fade */
const DEPART_MS = 5000;
const DEPART_FADE_MS = 700;
let departTimer = null;

function renderDecisions() {
	const section = document.getElementById("decisions-section");
	const list = document.getElementById("decisions-list");
	const count = document.getElementById("decisions-count");
	const now = Date.now();

	// An answered card we had shown as open lingers briefly with its ✓,
	// then fades — vanishing on click reads as harsh. Answered decisions
	// that were never on screen (e.g. after a reload) skip the farewell.
	for (const d of decisions) {
		if (d.status === "open") {
			seenOpenDecisions.add(d.id);
			departingDecisions.delete(d.id);
		} else if (seenOpenDecisions.has(d.id) && !departingDecisions.has(d.id)) {
			departingDecisions.set(d.id, now);
		}
	}
	for (const [id, at] of Array.from(departingDecisions)) {
		if (now - at >= DEPART_MS) {
			departingDecisions.delete(id);
			seenOpenDecisions.delete(id);
		}
	}

	const open = decisions.filter((d) => d.status === "open");
	const leaving = decisions.filter((d) => departingDecisions.has(d.id));
	const visible = open.concat(leaving);

	// Keep the section — and its history affordance — as long as any decision
	// exists this session. Only a never-used queue hides completely.
	if (decisions.length === 0) {
		section.style.display = "none";
		return;
	}
	section.style.display = "";
	count.textContent = open.length > 0 ? String(open.length) : "";

	list.innerHTML = "";

	if (visible.length === 0) {
		const answered = decisions.length;
		const empty = document.createElement("button");
		empty.className = "decisions-empty";
		empty.title = "Open all decisions in editor";
		const line1 = document.createElement("span");
		line1.className = "decisions-empty-title";
		line1.textContent = "Nothing waiting on you";
		const line2 = document.createElement("span");
		line2.className = "decisions-empty-hint";
		line2.textContent = answered + (answered === 1 ? " answered" : " answered") + " this session — view history";
		empty.appendChild(line1);
		empty.appendChild(line2);
		empty.addEventListener("click", () => vscode.postMessage({ type: "open_decisions_panel" }));
		list.appendChild(empty);
		if (departTimer) { clearTimeout(departTimer); departTimer = null; }
		return;
	}

	for (const d of visible) {
		const isLeaving = departingDecisions.has(d.id);
		const card = document.createElement("div");
		card.className = "decision-card" + (isLeaving ? " answered leaving" : "");
		if (isLeaving) {
			const elapsed = now - departingDecisions.get(d.id);
			card.style.animationDelay = Math.max(0, DEPART_MS - DEPART_FADE_MS - elapsed) + "ms";
		}

		const title = document.createElement("div");
		title.className = "decision-title";
		title.textContent = d.title;
		card.appendChild(title);

		const ctx = document.createElement("div");
		ctx.className = "decision-context";
		ctx.innerHTML = simpleMarkdown(d.context);
		card.appendChild(ctx);

		if (d.handoffPath) {
			const link = document.createElement("a");
			link.className = "decision-handoff";
			link.href = "#";
			link.textContent = d.handoffPath;
			link.addEventListener("click", (e) => {
				e.preventDefault();
				vscode.postMessage({ type: "open_handoff", path: d.handoffPath });
			});
			card.appendChild(link);
		}

		if (isLeaving) {
			const ans = document.createElement("div");
			ans.className = "decision-answer";
			ans.textContent = "✓ " + (d.answer || "answered");
			card.appendChild(ans);
		} else {
			const opts = document.createElement("div");
			opts.className = "decision-options";
			for (const opt of d.options || []) {
				const btn = document.createElement("button");
				btn.className = "decision-opt" + (opt.recommended ? " recommended" : "");
				btn.textContent = opt.label + (opt.recommended ? " ★" : "");
				if (opt.detail) btn.title = opt.detail;
				btn.addEventListener("click", () => {
					vscode.postMessage({ type: "decision_answer", id: d.id, answer: opt.label });
				});
				opts.appendChild(btn);
			}
			card.appendChild(opts);

			const custom = document.createElement("div");
			custom.className = "decision-custom";
			const input = document.createElement("input");
			input.type = "text";
			input.placeholder = "Or answer in your own words…";
			const send = document.createElement("button");
			send.textContent = "Send";
			const submit = () => {
				const v = input.value.trim();
				if (v) vscode.postMessage({ type: "decision_answer", id: d.id, answer: v });
			};
			send.addEventListener("click", submit);
			input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
			custom.appendChild(input);
			custom.appendChild(send);
			card.appendChild(custom);
		}

		list.appendChild(card);
	}

	// Re-render when the soonest farewell ends, to sweep it out of the DOM.
	if (departTimer) clearTimeout(departTimer);
	departTimer = null;
	if (departingDecisions.size > 0) {
		let soonest = Infinity;
		for (const at of departingDecisions.values()) {
			soonest = Math.min(soonest, at + DEPART_MS - now);
		}
		departTimer = setTimeout(renderDecisions, Math.max(50, soonest));
	}
}

// ── Distilled transcript feed ──

/** @type {Array<any>} */
let feedItems = [];

function renderFeed() {
	const section = document.getElementById("feed-section");
	const list = document.getElementById("feed-list");

	if (feedItems.length === 0) {
		section.style.display = "none";
		return;
	}
	section.style.display = "";
	list.innerHTML = "";

	for (const item of feedItems) {
		const row = document.createElement("div");
		row.className = "feed-item kind-" + item.kind;

		const head = document.createElement("div");
		head.className = "feed-item-head";

		const pill = document.createElement("span");
		pill.className = "feed-pill";
		pill.textContent = item.kind;
		head.appendChild(pill);

		const time = document.createElement("span");
		time.className = "feed-time";
		time.textContent = new Date(item.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
		head.appendChild(time);

		row.appendChild(head);

		const title = document.createElement("div");
		title.className = "feed-title";
		title.textContent = item.title;
		row.appendChild(title);

		if (item.body) {
			const body = document.createElement("div");
			body.className = "feed-body";
			body.innerHTML = simpleMarkdown(item.body);
			row.appendChild(body);
		}

		if (item.source) {
			const src = document.createElement("div");
			src.className = "feed-source";
			src.textContent = item.source;
			row.appendChild(src);
		}

		list.appendChild(row);
	}
}

document.getElementById("feed-clear").addEventListener("click", () => {
	vscode.postMessage({ type: "clear_feed" });
});

function simpleMarkdown(text) {
	if (!text) return "";
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
		.replace(/`(.+?)`/g, "<code>$1</code>")
		.replace(/\n\n/g, "<br><br>")
		.replace(/\n/g, "<br>");
}

// ── Hold-to-pause (spacebar) ──

let holdPaused = false;

// ── Shift modifier tracking ──

let shiftHeld = false;

function updateNavIcons() {
	const showSegment = shiftHeld || totalHighlights <= 1;
	document.querySelectorAll("#btn-prev, #btn-next").forEach((btn) => {
		const highlightIcon = btn.querySelector(".icon-highlight");
		const segmentIcon = btn.querySelector(".icon-segment");
		if (highlightIcon && segmentIcon) {
			highlightIcon.style.display = showSegment ? "none" : "";
			segmentIcon.style.display = showSegment ? "" : "none";
		}
	});
}

document.addEventListener("keydown", (e) => {
	if (e.key === "Shift" && !shiftHeld) {
		shiftHeld = true;
		updateNavIcons();
	}
	if (e.code === "Space" && !e.repeat) {
		// Don't intercept space on interactive elements
		if (e.target.tagName === "BUTTON" || e.target.tagName === "INPUT" || e.target.tagName === "SELECT") {
			return;
		}
		e.preventDefault();
		// Only hold-pause if currently playing (not if user-paused)
		if (state.status === "playing" && !holdPaused) {
			holdPaused = true;
			ensureAudioContext();
			vscode.postMessage({ type: "play_pause" });
		}
	}
});

document.addEventListener("keyup", (e) => {
	if (e.key === "Shift") {
		shiftHeld = false;
		updateNavIcons();
	}
	if (e.code === "Space") {
		// Don't intercept space on interactive elements
		if (e.target.tagName === "BUTTON" || e.target.tagName === "INPUT" || e.target.tagName === "SELECT") {
			return;
		}
		e.preventDefault();
		if (holdPaused) {
			holdPaused = false;
			vscode.postMessage({ type: "play_pause" });
		}
	}
});

window.addEventListener("blur", () => {
	holdPaused = false;
	shiftHeld = false;
	updateNavIcons();
});

// ── Event handlers ──

document.getElementById("btn-play-pause").addEventListener("click", () => {
	ensureAudioContext(); // Unlock AudioContext synchronously during user gesture
	vscode.postMessage({ type: "play_pause" });
});

document.getElementById("btn-next").addEventListener("click", () => {
	if (shiftHeld || totalHighlights <= 1) {
		vscode.postMessage({ type: "next" });
	} else {
		vscode.postMessage({ type: "next_highlight" });
	}
});

document.getElementById("btn-prev").addEventListener("click", () => {
	if (shiftHeld || totalHighlights <= 1) {
		vscode.postMessage({ type: "prev" });
	} else {
		vscode.postMessage({ type: "prev_highlight" });
	}
});

document.getElementById("btn-restart").addEventListener("click", () => {
	vscode.postMessage({ type: "restart" });
});

const askInput = document.getElementById("ask-input");
function sendAsk() {
	const question = askInput.value.trim();
	if (!question) return;
	vscode.postMessage({ type: "ask_navigator", question, segmentId: state.currentSegment });
	askInput.value = "";
}
askInput.addEventListener("keydown", (e) => { if (e.key === "Enter") sendAsk(); });
document.getElementById("ask-send").addEventListener("click", sendAsk);

document.getElementById("btn-theater").addEventListener("click", () => {
	vscode.postMessage({ type: "open_theater" });
});

document.getElementById("btn-save").addEventListener("click", () => {
	vscode.postMessage({ type: "save" });
});

document.getElementById("btn-close").addEventListener("click", () => {
	vscode.postMessage({ type: "close_walkthrough" });
});

document.getElementById("volume-slider").addEventListener("input", (e) => {
	volume = parseInt(e.target.value, 10) / 100;
	updateVolume();
	vscode.postMessage({ type: "volume_change", volume });
});

document.getElementById("btn-mute").addEventListener("click", () => {
	muted = !muted;
	document.getElementById("btn-mute").textContent = muted ? "\uD83D\uDD07" : "\uD83D\uDD0A";
	updateVolume();
	vscode.postMessage({ type: "mute_toggle" });
});

document.getElementById("voice-select").addEventListener("change", (e) => {
	vscode.postMessage({ type: "voice_change", voice: e.target.value });
});

// Speed buttons
document.querySelectorAll("#speed-buttons button").forEach((btn) => {
	btn.addEventListener("click", () => {
		const speed = parseFloat(btn.dataset.speed);
		document.querySelectorAll("#speed-buttons button").forEach((b) =>
			b.classList.remove("active"),
		);
		btn.classList.add("active");
		vscode.postMessage({ type: "speed_change", speed });
	});
});

// ── Message handler from extension ──

window.addEventListener("message", (event) => {
	const msg = event.data;

	switch (msg.type) {
		case "server_loading": {
			const btn = document.getElementById("btn-play-pause");
			if (msg.loading) {
				btn.classList.add("loading");
				btn.setAttribute("aria-busy", "true");
				btn.setAttribute("aria-disabled", "true");
			} else {
				btn.classList.remove("loading");
				btn.removeAttribute("aria-busy");
				btn.removeAttribute("aria-disabled");
			}
			break;
		}

		case "highlight_advance": {
			currentHighlightIndex = msg.highlightIndex;
			totalHighlights = msg.totalHighlights;
			renderHighlightProgress();
			const hlIdx = state.segments.findIndex((s) => s.id === state.currentSegment);
			if (hlIdx !== -1) renderOutline(hlIdx);
			// Update explanation if highlight has its own
			if (msg.explanation) {
				const explEl = document.getElementById("explanation-text");
				explEl.classList.add("fade-out");
				setTimeout(() => {
					explEl.innerHTML = simpleMarkdown(msg.explanation);
					explEl.classList.remove("fade-out");
				}, 150);
			} else {
				// Revert to segment-level explanation
				const seg = state.segments.find((s) => s.id === state.currentSegment);
				if (seg && seg.explanation) {
					const explEl = document.getElementById("explanation-text");
					explEl.classList.add("fade-out");
					setTimeout(() => {
						explEl.innerHTML = simpleMarkdown(seg.explanation);
						explEl.classList.remove("fade-out");
					}, 150);
				}
			}
			break;
		}

		case "update": {
			const prevSegment = state.currentSegment;
			state = {
				title: msg.title,
				segments: msg.segments,
				currentSegment: msg.currentSegment,
				status: msg.status,
			};
			// Only reset highlight state when the segment actually changed
			if (prevSegment !== msg.currentSegment) {
				currentHighlightIndex = 0;
				totalHighlights = 0;
			}
			// If something else resumed playback while spacebar was held, clear the flag
			if (state.status !== "paused") {
				holdPaused = false;
			}
			render();
			renderHighlightProgress();
			break;
		}

		case "set_volume":
			volume = msg.volume;
			updateVolume();
			document.getElementById("volume-slider").value = String(Math.round(volume * 100));
			break;

		case "audio_chunk": {
			const playBtn = document.getElementById("btn-play-pause");
			playBtn.classList.remove("loading");
			playBtn.removeAttribute("aria-busy");
			playBtn.removeAttribute("aria-disabled");
			playAudioChunk(msg.data, msg.sampleRate);
			break;
		}

		case "audio_end":
			onAudioEnd();
			break;

		case "audio_stop":
			stopAudio();
			break;

		case "audio_suspend":
			suspendAudio();
			break;

		case "audio_resume":
			resumeAudio();
			break;

		case "validity": {
			const banner = document.getElementById("validity-banner");
			const v = msg.validity;
			if (!v || v.overall === "fresh" || v.overall === "unknown") {
				banner.style.display = "none";
			} else {
				const stale = Object.values(v.segments || {}).filter((x) => x.state === "stale").length;
				banner.style.display = "";
				banner.className = "validity-banner " + (stale ? "stale" : "shifted");
				banner.textContent = stale
					? "\u26A0 " + stale + " segment" + (stale === 1 ? "" : "s") + " no longer match the code. Ask your agent to regenerate this walkthrough."
					: "\u21C5 Code moved since this walkthrough was made \u2014 line positions were adjusted automatically.";
			}
			break;
		}

		case "decisions":
			decisions = msg.decisions;
			renderDecisions();
			break;

		case "feed":
			feedItems = msg.items;
			renderFeed();
			break;

		case "saved_list": {
			const section = document.getElementById("saved-list-section");
			const list = document.getElementById("saved-list");
			if (msg.walkthroughs.length === 0) {
				section.style.display = "none";
				break;
			}
			section.style.display = "";
			list.innerHTML = "";
			for (const wt of msg.walkthroughs) {
				const li = document.createElement("li");
				li.className = "saved-item";
				li.textContent = wt.title;
				li.addEventListener("click", () => {
					vscode.postMessage({ type: "load", name: wt.name });
				});
				list.appendChild(li);
			}
			break;
		}
	}
});

document.getElementById("decisions-expand").addEventListener("click", () => {
	vscode.postMessage({ type: "open_decisions_panel" });
});

// Initial render
render();
vscode.postMessage({ type: "request_decisions" });
vscode.postMessage({ type: "request_feed" });
