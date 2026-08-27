import * as vscode from "vscode";
import type { Decision } from "./types";

let panel: vscode.WebviewPanel | undefined;

/**
 * Open (or reveal) the full decisions panel in the editor area.
 * Shows every decision — open and answered — unlike the sidebar,
 * which only shows what's still waiting on the user.
 */
export function openDecisionsPanel(
	onAnswer: (id: string, answer: string) => void,
	onOpenHandoff: (path: string) => void,
	getDecisions: () => Decision[],
): void {
	if (panel) {
		panel.reveal();
		updateDecisionsPanel(getDecisions());
		return;
	}

	panel = vscode.window.createWebviewPanel(
		"brix.decisions",
		"Brix — Waiting on You",
		vscode.ViewColumn.Active,
		{ enableScripts: true, retainContextWhenHidden: true },
	);
	panel.webview.html = getHtml();
	panel.webview.onDidReceiveMessage((msg: { type: string; id?: string; answer?: string; path?: string }) => {
		if (msg.type === "decision_answer" && msg.id && msg.answer) onAnswer(msg.id, msg.answer);
		else if (msg.type === "open_handoff" && msg.path) onOpenHandoff(msg.path);
		else if (msg.type === "ready") updateDecisionsPanel(getDecisions());
	});
	panel.onDidDispose(() => {
		panel = undefined;
	});
}

/** Push the current decision list into the panel, if it's open. */
export function updateDecisionsPanel(decisions: Decision[]): void {
	panel?.webview.postMessage({ type: "decisions", decisions });
}

function getHtml(): string {
	const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>Brix — Waiting on You</title>
<style>
	* { margin: 0; padding: 0; box-sizing: border-box; }
	body {
		font-family: var(--vscode-font-family);
		font-size: var(--vscode-font-size);
		color: var(--vscode-foreground);
		background: var(--vscode-editor-background);
		padding: 24px;
	}
	.wrap { max-width: 720px; margin: 0 auto; }
	h1 { font-size: 1.3em; margin-bottom: 4px; }
	.sub { color: var(--vscode-descriptionForeground); margin-bottom: 20px; }
	.group-label {
		font-size: 0.75em; font-weight: 700; letter-spacing: 0.1em;
		color: var(--vscode-descriptionForeground); margin: 18px 0 8px;
	}
	.card {
		border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
		border-left: 3px solid var(--vscode-charts-orange, #e2a144);
		border-radius: 6px; padding: 14px 16px; margin-bottom: 10px;
		background: var(--vscode-editorWidget-background, transparent);
	}
	.card.answered { opacity: 0.7; border-left-color: var(--vscode-charts-green, #58b586); }
	.meta { display: flex; gap: 10px; align-items: baseline; font-size: 0.8em;
		color: var(--vscode-descriptionForeground); margin-bottom: 6px; }
	.pill { font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; font-size: 0.9em; }
	.pill.open { color: var(--vscode-charts-orange, #e2a144); }
	.pill.done { color: var(--vscode-charts-green, #58b586); }
	.title { font-weight: 600; font-size: 1.05em; margin-bottom: 6px; }
	.context { color: var(--vscode-descriptionForeground); margin-bottom: 10px; max-width: 65ch; }
	.handoff { display: inline-block; font-family: var(--vscode-editor-font-family, monospace);
		font-size: 0.85em; color: var(--vscode-textLink-foreground); margin-bottom: 10px;
		text-decoration: none; cursor: pointer; }
	.handoff:hover { text-decoration: underline; }
	.options { display: flex; flex-wrap: wrap; gap: 7px; margin-bottom: 9px; }
	.opt {
		border: 1px solid var(--vscode-button-border, transparent);
		background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.2));
		color: var(--vscode-button-secondaryForeground, inherit);
		border-radius: 4px; padding: 5px 12px; cursor: pointer; font-size: 0.95em;
	}
	.opt:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,0.35)); }
	.opt.recommended { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
	.opt.recommended:hover { background: var(--vscode-button-hoverBackground); }
	.custom { display: flex; gap: 7px; }
	.custom input {
		flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
		border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px;
		padding: 5px 9px; font: inherit;
	}
	.custom button {
		border: none; background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.2));
		color: var(--vscode-button-secondaryForeground, inherit); border-radius: 4px;
		padding: 5px 12px; cursor: pointer;
	}
	.answer { font-weight: 600; color: var(--vscode-charts-green, #58b586); }
	.empty { color: var(--vscode-descriptionForeground); padding: 30px 0; text-align: center; }
</style>
</head>
<body>
<div class="wrap">
	<h1>Waiting on You</h1>
	<p class="sub">Every decision the agent has raised this session — open ones first, answered kept as history.</p>
	<div id="list"></div>
</div>
<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	let decisions = [];

	function esc(t) {
		return String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	}

	function fmtTime(ts) {
		try { return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
		catch { return ""; }
	}

	function render() {
		const list = document.getElementById("list");
		list.innerHTML = "";
		if (decisions.length === 0) {
			list.innerHTML = '<div class="empty">No decisions raised yet.</div>';
			return;
		}
		const open = decisions.filter(d => d.status === "open");
		const done = decisions.filter(d => d.status !== "open");

		const addGroup = (label, items) => {
			if (items.length === 0) return;
			const gl = document.createElement("div");
			gl.className = "group-label";
			gl.textContent = label;
			list.appendChild(gl);
			for (const d of items) list.appendChild(card(d));
		};
		addGroup("OPEN — " + open.length, open);
		addGroup("ANSWERED", done);
	}

	function card(d) {
		const el = document.createElement("div");
		el.className = "card" + (d.status === "answered" ? " answered" : "");
		const isOpen = d.status === "open";
		el.innerHTML =
			'<div class="meta"><span class="pill ' + (isOpen ? "open" : "done") + '">' + (isOpen ? "Waiting" : "Answered") + '</span>' +
			'<span>raised ' + fmtTime(d.raisedAt) + '</span></div>' +
			'<div class="title">' + esc(d.title) + '</div>' +
			'<div class="context">' + esc(d.context) + '</div>';
		if (d.handoffPath) {
			const a = document.createElement("a");
			a.className = "handoff";
			a.textContent = d.handoffPath;
			a.addEventListener("click", () => vscode.postMessage({ type: "open_handoff", path: d.handoffPath }));
			el.appendChild(a);
		}
		if (isOpen) {
			const opts = document.createElement("div");
			opts.className = "options";
			for (const o of d.options || []) {
				const b = document.createElement("button");
				b.className = "opt" + (o.recommended ? " recommended" : "");
				b.textContent = o.label + (o.recommended ? " ★" : "");
				if (o.detail) b.title = o.detail;
				b.addEventListener("click", () => vscode.postMessage({ type: "decision_answer", id: d.id, answer: o.label }));
				opts.appendChild(b);
			}
			el.appendChild(opts);
			const custom = document.createElement("div");
			custom.className = "custom";
			const input = document.createElement("input");
			input.placeholder = "Or answer in your own words…";
			const send = document.createElement("button");
			send.textContent = "Send";
			const submit = () => { const v = input.value.trim(); if (v) vscode.postMessage({ type: "decision_answer", id: d.id, answer: v }); };
			send.addEventListener("click", submit);
			input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
			custom.appendChild(input);
			custom.appendChild(send);
			el.appendChild(custom);
		} else {
			const ans = document.createElement("div");
			ans.className = "answer";
			ans.textContent = "✓ " + (d.answer || "answered");
			el.appendChild(ans);
		}
		return el;
	}

	window.addEventListener("message", (e) => {
		if (e.data.type === "decisions") { decisions = e.data.decisions; render(); }
	});
	render();
	vscode.postMessage({ type: "ready" });
</script>
</body>
</html>`;
}
