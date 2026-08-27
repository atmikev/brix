import * as fs from "fs";
import * as crypto from "crypto";
import * as cp from "child_process";
import type { Segment } from "./types";

/**
 * Walkthroughs pin file:line ranges, so any edit can silently point narration
 * at the wrong code. We snapshot the files a plan was built against, then
 * re-check them: unchanged files stay fresh, pure line shifts are relocated
 * automatically via anchor text, and anything we can't place is marked stale.
 */

export interface SegmentAnchor {
	file: string;
	/** trimmed text of the segment's first line */
	anchor: string;
	/** trimmed first line of each highlight */
	highlightAnchors: string[];
}

export interface PlanIntegrity {
	commit?: string;
	capturedAt: number;
	/** absolute path -> content hash at capture time */
	files: Record<string, string>;
	segments: Record<number, SegmentAnchor>;
}

export type SegmentValidity =
	| { state: "fresh" }
	| { state: "shifted"; delta: number }
	| { state: "stale"; reason: string };

export interface PlanValidity {
	/** worst state across all segments */
	overall: "fresh" | "shifted" | "stale";
	commit?: string;
	currentCommit?: string;
	capturedAt: number;
	segments: Record<number, SegmentValidity>;
}

function hash(content: string): string {
	return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function lineAt(lines: string[], oneBased: number): string {
	return (lines[oneBased - 1] ?? "").trim();
}

export function headCommit(cwd: string | undefined): string | undefined {
	if (!cwd) return undefined;
	try {
		return cp.execSync("git rev-parse HEAD", { cwd, stdio: ["ignore", "pipe", "ignore"] })
			.toString().trim();
	} catch {
		return undefined;
	}
}

/** Snapshot the files and anchor text a plan was built against. */
export async function capture(segments: Segment[], cwd?: string): Promise<PlanIntegrity> {
	const files: Record<string, string> = {};
	const segs: Record<number, SegmentAnchor> = {};

	for (const seg of segments) {
		let content: string;
		try {
			content = await fs.promises.readFile(seg.file, "utf-8");
		} catch {
			continue;
		}
		files[seg.file] = hash(content);
		const lines = content.split("\n");
		segs[seg.id] = {
			file: seg.file,
			anchor: lineAt(lines, seg.start),
			highlightAnchors: (seg.highlights || []).map((h) => lineAt(lines, h.start)),
		};
	}

	return { commit: headCommit(cwd), capturedAt: Date.now(), files, segments: segs };
}

/**
 * Re-check a plan against what's on disk now.
 * Returns per-segment validity; callers apply shifts via `shiftSegment`.
 */
export async function validate(
	segments: Segment[],
	integrity: PlanIntegrity,
	cwd?: string,
): Promise<PlanValidity> {
	const result: Record<number, SegmentValidity> = {};
	const contents = new Map<string, string | null>();

	for (const seg of segments) {
		if (!contents.has(seg.file)) {
			try {
				contents.set(seg.file, await fs.promises.readFile(seg.file, "utf-8"));
			} catch {
				contents.set(seg.file, null);
			}
		}
		const content = contents.get(seg.file) ?? null;
		if (content === null) {
			result[seg.id] = { state: "stale", reason: "file no longer exists" };
			continue;
		}

		const captured = integrity.files[seg.file];
		if (captured && hash(content) === captured) {
			result[seg.id] = { state: "fresh" };
			continue;
		}

		const anchors = integrity.segments[seg.id];
		if (!anchors) {
			result[seg.id] = { state: "stale", reason: "no anchor recorded" };
			continue;
		}

		const lines = content.split("\n");
		if (lineAt(lines, seg.start) === anchors.anchor && anchorsMatch(lines, seg, anchors, 0)) {
			result[seg.id] = { state: "fresh" };
			continue;
		}

		// Anchor text moved — relocate if it still appears exactly once.
		const hits: number[] = [];
		for (let i = 0; i < lines.length; i++) {
			if (lines[i].trim() === anchors.anchor && anchors.anchor !== "") hits.push(i + 1);
		}
		if (hits.length === 1) {
			const delta = hits[0] - seg.start;
			if (anchorsMatch(lines, seg, anchors, delta)) {
				result[seg.id] = { state: "shifted", delta };
				continue;
			}
			result[seg.id] = { state: "stale", reason: "highlighted lines changed" };
			continue;
		}
		result[seg.id] = {
			state: "stale",
			reason: hits.length === 0 ? "code was edited or removed" : "anchor is ambiguous now",
		};
	}

	const states = Object.values(result).map((r) => r.state);
	const overall = states.includes("stale") ? "stale" : states.includes("shifted") ? "shifted" : "fresh";

	return {
		overall,
		commit: integrity.commit,
		currentCommit: headCommit(cwd),
		capturedAt: integrity.capturedAt,
		segments: result,
	};
}

function anchorsMatch(lines: string[], seg: Segment, anchors: SegmentAnchor, delta: number): boolean {
	const highlights = seg.highlights || [];
	return highlights.every((h, i) => {
		const expected = anchors.highlightAnchors[i];
		if (expected === undefined) return true;
		return lineAt(lines, h.start + delta) === expected;
	});
}

/** Apply a validated line shift to a segment (returns a new object). */
export function shiftSegment(seg: Segment, delta: number): Segment {
	return {
		...seg,
		start: seg.start + delta,
		end: seg.end + delta,
		highlights: (seg.highlights || []).map((h) => ({ ...h, start: h.start + delta, end: h.end + delta })),
	};
}
