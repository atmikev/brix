// ── Navigator: a brix-hosted pair-programming partner ──
// A second, read-only LLM the extension calls directly (any provider). It must
// finish by calling the required `deliver` tool, whose code-anchored utterances
// compile into the existing walkthrough / decision / feed surfaces — so walls
// of text are impossible by construction.

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as cp from "child_process";
import type { AgentMessage, FeedKind, Segment } from "./types";
import type { WalkthroughState } from "./walkthrough";
import { makeProvider, ChatFn, NavMessage, NavTool, ToolCall } from "./providers";

const MAX_TURNS = 16;
const MAX_READ_LINES = 250;
const MAX_READ_BYTES = 5_000_000;
const MAX_SEARCH_MATCHES = 50;
const MAX_DIFF_BYTES = 60_000;
const MAX_UTTERANCES = 50;

const SYSTEM_PROMPT = `You are the navigator in a pair-programming session, hosted inside the Brix VS Code extension. The human is the driver. You are terse, concrete, and adversarial in the best sense: your job is to catch what the driver and their coding agent missed — bugs, missed call sites, convention drift, risky assumptions — and to explain code by pointing at it, never by lecturing.

You are READ-ONLY. You cannot edit files or run commands. You have three exploration tools (read_file, search, git_diff) and one delivery tool (deliver).

## How to work

1. Explore before judging. Read the actual code around anything you plan to comment on. A diff cannot be judged without the surrounding code it lands in — check the callers, the siblings, the conventions of the file.
2. Only anchor claims to lines you have actually read with read_file in this conversation. Never guess line numbers.
3. When you have formed your assessment, call deliver EXACTLY ONCE with everything. Do not print your findings as text — text outside deliver is discarded.

## The deliver call

- title: 3-6 word title for this review or answer.
- verdict: 2-4 plain sentences, your overall assessment. This is the summary a busy human reads first.
- utterances: your points, most important first. Each has a kind:
  - "say" — a point anchored to specific code. Requires file (workspace-relative path, e.g. "src/server.ts" — never absolute), start and end (1-based inclusive line numbers you actually read), and spoken.
  - "finding" — a side observation not tied to one code location.
  - "question" — something that needs the human's verdict. Give 2-4 options; mark one recommended if you have a view.

## Writing "spoken"

spoken is read aloud by text-to-speech while the editor highlights your lines. Write 1-3 flowing sentences of plain speech: no markdown, no backticks, no file paths, no line numbers, no bullet lists — say "this function" or "the check here", because the listener is looking at the highlighted code. Use connectives so consecutive utterances flow like one narration. Anything that needs markdown, identifiers, or precision goes in detail, which is shown on screen alongside.

## Choosing kinds

A concrete problem or observation in specific code: say. A cross-cutting worry, missing test, or process note: finding. A judgment call only the human can make (accept this tradeoff? rename this? ship anyway?): question. Prefer a handful of sharp utterances over exhaustive coverage — you are pacing a human, not filing a report.`;

// ── Tools ──

const TOOLS: NavTool[] = [
	{
		name: "read_file",
		description:
			"Read a file from the workspace (workspace-relative path). Returns numbered lines. Optional start/end (1-based, inclusive) to read a slice; at most 250 lines per call.",
		inputSchema: {
			type: "object",
			required: ["path"],
			properties: {
				path: { type: "string" },
				start: { type: "integer", minimum: 1 },
				end: { type: "integer", minimum: 1 },
			},
		},
	},
	{
		name: "search",
		description:
			"Search file contents in the workspace with git grep (regex). Returns file:line:text matches, at most 50. Optional glob to limit paths, e.g. 'src/*.ts'.",
		inputSchema: {
			type: "object",
			required: ["pattern"],
			properties: { pattern: { type: "string" }, glob: { type: "string" } },
		},
	},
	{
		name: "git_diff",
		description:
			"Show the working-tree diff (against HEAD by default, or against the given base ref).",
		inputSchema: { type: "object", properties: { base: { type: "string" } } },
	},
	{
		name: "deliver",
		description:
			"Deliver your final structured assessment. Call exactly once, when your exploration is done. This is the only output the human sees.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["title", "verdict", "utterances"],
			properties: {
				title: { type: "string", description: "3-6 word walkthrough title" },
				verdict: { type: "string", description: "2-4 plain sentences: overall assessment" },
				utterances: {
					type: "array",
					items: {
						type: "object",
						additionalProperties: false,
						required: ["kind", "title"],
						properties: {
							kind: { enum: ["say", "finding", "question"] },
							title: { type: "string" },
							file: { type: "string", description: "say: workspace-relative path" },
							start: { type: "integer", minimum: 1 },
							end: { type: "integer", minimum: 1 },
							spoken: { type: "string", description: "say: 1-3 spoken sentences, plain text" },
							detail: { type: "string", description: "optional markdown" },
							options: {
								type: "array",
								items: {
									type: "object",
									required: ["label"],
									properties: {
										label: { type: "string" },
										detail: { type: "string" },
										recommended: { type: "boolean" },
									},
								},
							},
						},
					},
				},
			},
		},
	},
];

interface DeliverUtterance {
	kind: "say" | "finding" | "question";
	title: string;
	file?: string;
	start?: number;
	end?: number;
	spoken?: string;
	detail?: string;
	options?: { label: string; detail?: string; recommended?: boolean }[];
}

interface Deliver {
	title: string;
	verdict: string;
	utterances: DeliverUtterance[];
}

function validateDeliver(input: unknown): string[] {
	const errors: string[] = [];
	const d = input as Partial<Deliver> | null;
	if (!d || typeof d !== "object") return ["deliver input must be an object"];
	if (typeof d.title !== "string" || !d.title.trim()) errors.push("title: non-empty string required");
	if (typeof d.verdict !== "string" || !d.verdict.trim()) errors.push("verdict: non-empty string required");
	if (!Array.isArray(d.utterances)) {
		errors.push("utterances: array required");
		return errors;
	}
	d.utterances.forEach((u, i) => {
		if (!u || typeof u !== "object") { errors.push(`utterances[${i}]: must be an object`); return; }
		if (!["say", "finding", "question"].includes(u.kind)) errors.push(`utterances[${i}].kind: must be say|finding|question`);
		if (typeof u.title !== "string" || !u.title.trim()) errors.push(`utterances[${i}].title: non-empty string required`);
		if (u.kind === "say") {
			if (typeof u.file !== "string" || !u.file.trim()) errors.push(`utterances[${i}].file: required for say`);
			if (typeof u.start !== "number" || u.start < 1) errors.push(`utterances[${i}].start: 1-based integer required for say`);
			if (typeof u.end !== "number" || u.end < 1) errors.push(`utterances[${i}].end: 1-based integer required for say`);
			if (typeof u.spoken !== "string" || !u.spoken.trim()) errors.push(`utterances[${i}].spoken: required for say`);
		}
	});
	return errors;
}

// ── Wiring ──

export interface NavigatorDeps {
	dispatch: (msg: AgentMessage) => void;
	addFeedItem: (item: { kind: FeedKind; title: string; body?: string; source?: string }) => void;
	getWalkthrough: () => WalkthroughState;
	captureIntegrity: () => Promise<void>;
	prewarmTTS: () => void;
	wsFolder: string | undefined;
}

export interface Navigator {
	isConfigured(): boolean;
	ask(question: string, segmentId: number): void;
	reviewDiff(): void;
}

export function createNavigator(context: vscode.ExtensionContext, deps: NavigatorDeps): Navigator {
	let busy = false;
	let navSeq = 0;

	function config() {
		const c = vscode.workspace.getConfiguration("brix.navigator");
		return {
			provider: c.get<string>("provider", "off"),
			model: c.get<string>("model", "claude-opus-5"),
			baseUrl: c.get<string>("baseUrl", ""),
		};
	}

	function git(args: string[]): string {
		// same shape as integrity.ts headCommit: pinned cwd, swallowed failures
		try {
			return cp
				.execFileSync("git", args, { cwd: deps.wsFolder, maxBuffer: 10 * 1024 * 1024 })
				.toString();
		} catch {
			return "";
		}
	}

	function truncate(text: string, bytes: number): string {
		return text.length > bytes
			? text.slice(0, bytes) + "\n[truncated — use git_diff/read_file for more]"
			: text;
	}

	/**
	 * Resolve a model-supplied path and confirm it stays inside the workspace,
	 * following symlinks (realpath) so an in-workspace link can't point out.
	 * Returns the absolute path, or undefined if it escapes / doesn't exist.
	 */
	function containedAbs(rel: string): string | undefined {
		if (!deps.wsFolder) return undefined;
		try {
			const abs = path.resolve(deps.wsFolder, rel);
			const real = fs.realpathSync(abs);
			const root = fs.realpathSync(deps.wsFolder);
			if (real === root || real.startsWith(root + path.sep)) return abs;
		} catch {
			/* missing file or broken/looping link → not readable */
		}
		return undefined;
	}

	function executeTool(call: ToolCall): { id: string; content: string; isError?: boolean } {
		const fail = (content: string) => ({ id: call.id, content, isError: true });
		if (call.invalidJson !== undefined) return fail("tool arguments were not valid JSON — retry with valid JSON");
		if (!deps.wsFolder) return fail("no workspace folder open");
		const input = (call.input ?? {}) as Record<string, unknown>;

		try {
			switch (call.name) {
				case "read_file": {
					const rel = String(input.path ?? "");
					const abs = containedAbs(rel);
					if (!abs) return fail(`path not found in workspace: ${rel}`);
					if (fs.statSync(abs).size > MAX_READ_BYTES) return fail(`file too large to read: ${rel}`);
					const lines = fs.readFileSync(abs, "utf-8").split("\n");
					const start = Math.max(1, Number(input.start) || 1);
					const requestedEnd = Number(input.end) || start + MAX_READ_LINES - 1;
					const end = Math.min(lines.length, requestedEnd, start + MAX_READ_LINES - 1);
					const body = lines
						.slice(start - 1, end)
						.map((l, i) => `${start + i}\t${l}`)
						.join("\n");
					const note = end < Math.min(lines.length, requestedEnd) ? `\n[capped at ${MAX_READ_LINES} lines; file has ${lines.length}]` : "";
					return { id: call.id, content: `${rel} (lines ${start}-${end} of ${lines.length}):\n${body}${note}` };
				}
				case "search": {
					const pattern = String(input.pattern ?? "");
					if (!pattern) return fail("pattern required");
					const args = ["grep", "-nI", "-e", pattern];
					if (typeof input.glob === "string" && input.glob) args.push("--", input.glob);
					const out = git(args);
					if (!out.trim()) return { id: call.id, content: "no matches" };
					const matches = out.trim().split("\n");
					const shown = matches.slice(0, MAX_SEARCH_MATCHES).join("\n");
					const note = matches.length > MAX_SEARCH_MATCHES ? `\n[${matches.length - MAX_SEARCH_MATCHES} more matches not shown]` : "";
					return { id: call.id, content: shown + note };
				}
				case "git_diff": {
					const base = typeof input.base === "string" && input.base ? input.base : "HEAD";
					// A leading dash lets git parse the ref as an option (e.g.
					// --output=/path writes an arbitrary file). Refuse it.
					if (base.startsWith("-")) return fail("invalid base ref");
					const out = git(["diff", base]);
					return { id: call.id, content: out.trim() ? truncate(out, MAX_DIFF_BYTES) : "no changes" };
				}
				default:
					return fail(`unknown tool: ${call.name}`);
			}
		} catch (e) {
			return fail(String(e));
		}
	}

	// ── Compile deliver → brix surfaces ──

	function compileAndDispatch(d: Deliver, mode: "review" | "ask"): void {
		const says: DeliverUtterance[] = [];
		const findings: DeliverUtterance[] = [];
		const questions: DeliverUtterance[] = [];

		// Cap the volume a misbehaving endpoint can flood into the surfaces.
		const utterances = d.utterances.slice(0, MAX_UTTERANCES);
		for (const u of utterances) {
			if (u.kind === "question") { questions.push(u); continue; }
			if (u.kind !== "say") { findings.push(u); continue; }
			// Anchor safety: model emits workspace-relative paths; resolve, verify,
			// clamp. A bad anchor downgrades to a finding — never drop, never fake.
			const anchored = anchorSay(u);
			if (anchored) says.push(anchored);
			else findings.push({ ...u, kind: "finding", title: `${u.title} (unanchored)`, detail: u.detail ?? u.spoken });
		}

		// verdict first, then walkthrough, then findings, then questions
		// (so the decision toast pops last)
		deps.addFeedItem({
			kind: mode === "ask" ? "answer" : "finding",
			title: d.title,
			body: d.verdict,
			source: "navigator",
		});

		if (says.length > 0) {
			const st = deps.getWalkthrough();
			const active = mode === "ask" && st.segments.length > 0 && st.currentIndex >= 0;
			let nextId = active ? Math.max(...st.segments.map((s) => s.id)) + 1 : 1;
			const segments: Segment[] = says.map((u) => ({
				id: nextId++,
				file: path.resolve(deps.wsFolder!, u.file!),
				start: u.start!,
				end: u.end!,
				title: u.title,
				explanation: u.detail ?? u.spoken!,
				highlights: [{ start: u.start!, end: u.end!, ttsText: u.spoken! }],
			}));
			if (active) {
				deps.dispatch({ type: "insert_after", afterSegment: st.segments[st.currentIndex].id, segments });
				// the insert_after dispatch path doesn't re-capture integrity; set_plan does
				deps.captureIntegrity().catch(() => {});
			} else {
				deps.dispatch({ type: "set_plan", title: d.title, segments });
			}
		}

		for (const u of findings) {
			deps.dispatch({ type: "post_update", item: { kind: "finding", title: u.title, body: u.detail, source: "navigator" } });
		}
		for (const u of questions) {
			deps.dispatch({
				type: "raise_decision",
				decision: {
					id: `nav-${++navSeq}`,
					title: u.title,
					context: u.detail ?? "",
					options: u.options?.length ? u.options : [{ label: "Yes" }, { label: "No" }],
				},
			});
		}
	}

	function anchorSay(u: DeliverUtterance): DeliverUtterance | undefined {
		const abs = containedAbs(u.file!);
		if (!abs) return undefined;
		let lineCount: number;
		try {
			lineCount = fs.readFileSync(abs, "utf-8").split("\n").length;
		} catch {
			return undefined;
		}
		const start = Math.max(1, Math.min(u.start!, lineCount));
		const end = Math.max(start, Math.min(u.end!, lineCount));
		return { ...u, start, end, spoken: u.spoken!.trim() || u.title };
	}

	// ── The loop ──

	async function run(seed: string, mode: "review" | "ask"): Promise<void> {
		if (busy) {
			vscode.window.showWarningMessage("Brix: navigator is already working on something");
			return;
		}
		busy = true;
		try {
			const cfg = config();
			const apiKey = (await context.secrets.get("brix.navigator.apiKey")) ?? "";
			if (cfg.provider === "anthropic" && !apiKey) {
				deps.addFeedItem({ kind: "info", title: "Navigator: no API key set — run “Brix: Set Navigator API Key”", source: "navigator" });
				return;
			}
			deps.prewarmTTS();
			deps.addFeedItem({
				kind: "progress",
				title: mode === "review" ? "Navigator: reviewing diff…" : "Navigator: thinking…",
				source: "navigator",
			});

			const chat: ChatFn = makeProvider({ ...cfg, apiKey });
			const messages: NavMessage[] = [{ role: "user", text: seed }];
			let deliverRetried = false;
			let lastText = "";

			for (let turn = 0; turn < MAX_TURNS; turn++) {
				const force = turn === MAX_TURNS - 1 ? "deliver" : undefined;
				let res;
				try {
					res = await chat(SYSTEM_PROMPT, messages, TOOLS, force);
				} catch (e) {
					// some servers 400 on forced tool_choice — retry the endgame unforced
					if (force) res = await chat(SYSTEM_PROMPT, messages, TOOLS);
					else throw e;
				}
				messages.push({ role: "assistant", text: res.text, toolCalls: res.toolCalls, raw: res.raw });
				if (res.text) lastText = res.text;

				const deliver = res.toolCalls.find((c) => c.name === "deliver");
				if (deliver) {
					const errors = deliver.invalidJson !== undefined ? ["deliver arguments were not valid JSON"] : validateDeliver(deliver.input);
					if (errors.length === 0) {
						compileAndDispatch(deliver.input as Deliver, mode);
						return;
					}
					if (deliverRetried) break; // second bad deliver → degrade
					deliverRetried = true;
					messages.push({
						role: "toolResults",
						results: res.toolCalls.map((c) =>
							c === deliver
								? { id: c.id, content: `Invalid deliver: ${errors.join("; ")}. Call deliver again.`, isError: true }
								: executeTool(c),
						),
					});
					continue;
				}

				if (res.toolCalls.length === 0) {
					messages.push({ role: "user", text: "Use the tools to explore, then call deliver with your assessment." });
					continue;
				}
				messages.push({ role: "toolResults", results: res.toolCalls.map(executeTool) });
			}

			// never lose content; never fabricate segments
			deps.addFeedItem({
				kind: "info",
				title: "Navigator (unstructured)",
				body: lastText || "The navigator did not produce a structured result.",
				source: "navigator",
			});
		} catch (e) {
			deps.addFeedItem({ kind: "info", title: "Navigator error", body: String(e), source: "navigator" });
		} finally {
			busy = false;
		}
	}

	return {
		isConfigured: () => config().provider !== "off",

		ask(question: string, segmentId: number): void {
			const st = deps.getWalkthrough();
			const seg = st.segments.find((s) => s.id === segmentId) ?? st.segments[st.currentIndex];
			let seed = `The driver asks: ${question}`;
			if (seg && deps.wsFolder) {
				const rel = path.relative(deps.wsFolder, seg.file);
				seed += `\n\nContext: they are in the walkthrough "${st.title}", viewing "${seg.title}" (${rel} lines ${seg.start}-${seg.end}): ${seg.explanation}`;
			}
			run(seed, "ask");
		},

		reviewDiff(): void {
			if (config().provider === "off") {
				vscode.window.showInformationMessage("Brix: set brix.navigator.provider in settings to enable the navigator");
				return;
			}
			const diff = git(["diff", "HEAD"]);
			if (!diff.trim()) {
				vscode.window.showInformationMessage("Brix: no working-tree changes to review");
				return;
			}
			const seed = `Review this working-tree diff adversarially: what did it miss, what does it break, what conventions does it drift from? Read the surrounding code before judging — the diff alone is not enough.\n\n${truncate(diff, MAX_DIFF_BYTES)}`;
			run(seed, "review");
		},
	};
}
