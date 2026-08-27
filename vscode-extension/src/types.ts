// ── Walkthrough data ──

export interface Highlight {
	start: number;   // 1-based line number
	end: number;     // 1-based line number
	ttsText: string; // narration for these specific lines
	explanation?: string; // optional per-highlight explanation
}

export interface Segment {
	id: number;
	file: string;
	start: number;
	end: number;
	title: string;
	explanation: string;
	highlights: Highlight[];
}

// ── Decisions (human-in-the-loop) ──

export interface DecisionOption {
	label: string;
	detail?: string;
	recommended?: boolean;
}

export interface Decision {
	id: string;              // stable slug, doubles as the handoff doc slug
	title: string;           // one-line question
	context: string;         // 2-3 sentence distilled context
	options: DecisionOption[];
	handoffPath?: string;    // e.g. docs/handoffs/2026-08-26-storage-backend.md
	status: "open" | "answered";
	answer?: string;
	raisedAt: number;        // epoch ms
}

// ── Distilled transcript feed ──

export type FeedKind = "finding" | "answer" | "status" | "progress" | "info";

export interface FeedItem {
	id: string;
	kind: FeedKind;
	title: string;
	body?: string;
	source?: string; // e.g. "review scout", "task:migration"
	ts: number;      // epoch ms
}

// ── Agent → Extension messages (HTTP + WS) ──

export interface SetPlanMessage {
	type: "set_plan";
	title: string;
	segments: Segment[];
}

export interface InsertAfterMessage {
	type: "insert_after";
	afterSegment: number;
	segments: Segment[];
}

export interface ReplaceSegmentMessage {
	type: "replace_segment";
	id: number;
	segment: Segment;
}

export interface RemoveSegmentsMessage {
	type: "remove_segments";
	ids: number[];
}

export interface GotoMessage {
	type: "goto";
	segmentId: number;
}

export interface ResumeMessage {
	type: "resume";
}

export interface StopMessage {
	type: "stop";
}

export interface RaiseDecisionMessage {
	type: "raise_decision";
	decision: {
		id: string;
		title: string;
		context: string;
		options: DecisionOption[];
		handoffPath?: string;
	};
}

export interface ResolveDecisionMessage {
	type: "resolve_decision";
	id: string;
	answer?: string; // omit to withdraw/clear the decision instead
}

export interface PostUpdateMessage {
	type: "post_update";
	item: {
		id?: string;
		kind: FeedKind;
		title: string;
		body?: string;
		source?: string;
	};
}

export interface WatchTaskMessage {
	type: "watch_task";
	id: string;
	title: string;
	intervalSec?: number; // default 300, min 60
}

export interface EndTaskMessage {
	type: "end_task";
	id: string;
	summary?: string;
}

export type AgentMessage =
	| SetPlanMessage
	| InsertAfterMessage
	| ReplaceSegmentMessage
	| RemoveSegmentsMessage
	| GotoMessage
	| ResumeMessage
	| StopMessage
	| RaiseDecisionMessage
	| ResolveDecisionMessage
	| PostUpdateMessage
	| WatchTaskMessage
	| EndTaskMessage;

// ── Extension → Agent messages ──

export type WalkthroughStatus = "playing" | "paused" | "stopped" | "idle";

export interface StateMessage {
	type: "state";
	currentSegment: number;
	status: WalkthroughStatus;
	totalSegments: number;
}

export interface UserQuestionActionMessage {
	type: "user_action";
	action: "ask_question";
	segmentId: number;
	question?: string;
}

export interface DecisionAnsweredActionMessage {
	type: "user_action";
	action: "decision_answered";
	decisionId: string;
	answer: string;
	handoffPath?: string;
}

export interface StatusRequestActionMessage {
	type: "user_action";
	action: "status_request";
	taskId: string;
	title: string;
}

export type UserActionMessage =
	| UserQuestionActionMessage
	| DecisionAnsweredActionMessage
	| StatusRequestActionMessage;

export type ExtensionMessage = StateMessage | UserActionMessage;

// ── Extension ↔ Webview messages ──

export interface WebviewUpdateMessage {
	type: "update";
	title: string;
	segments: Segment[];
	currentSegment: number;
	status: WalkthroughStatus;
}

export interface WebviewAudioChunkMessage {
	type: "audio_chunk";
	data: string; // base64-encoded float32 PCM
	sampleRate: number;
}

export interface WebviewAudioEndMessage {
	type: "audio_end";
}

export interface WebviewAudioStopMessage {
	type: "audio_stop";
}

export interface WebviewAudioSuspendMessage {
	type: "audio_suspend";
}

export interface WebviewAudioResumeMessage {
	type: "audio_resume";
}

export interface WebviewHighlightAdvanceMessage {
	type: "highlight_advance";
	highlightIndex: number;
	totalHighlights: number;
	explanation?: string;
}

export interface WebviewServerLoadingMessage {
	type: "server_loading";
	loading: boolean;
}

export interface WebviewSavedListMessage {
	type: "saved_list";
	walkthroughs: Array<{ name: string; title: string }>;
}

export interface WebviewSetVolumeMessage {
	type: "set_volume";
	volume: number;
}

export interface WebviewDecisionsMessage {
	type: "decisions";
	decisions: Decision[];
}

export interface WebviewFeedMessage {
	type: "feed";
	items: FeedItem[];
}

export interface WebviewValidityMessage {
	type: "validity";
	validity: import("./integrity").PlanValidity | null;
}

export type ToWebviewMessage =
	| WebviewDecisionsMessage
	| WebviewFeedMessage
	| WebviewValidityMessage
	| WebviewSetVolumeMessage
	| WebviewUpdateMessage
	| WebviewAudioChunkMessage
	| WebviewAudioEndMessage
	| WebviewAudioStopMessage
	| WebviewAudioSuspendMessage
	| WebviewAudioResumeMessage
	| WebviewHighlightAdvanceMessage
	| WebviewServerLoadingMessage
	| WebviewSavedListMessage;

export interface WebviewPlayPauseMessage {
	type: "play_pause";
}

export interface WebviewNextMessage {
	type: "next";
}

export interface WebviewPrevMessage {
	type: "prev";
}

export interface WebviewGotoSegmentMessage {
	type: "goto_segment";
	segmentId: number;
}

export interface WebviewSpeedChangeMessage {
	type: "speed_change";
	speed: number;
}

export interface WebviewVolumeChangeMessage {
	type: "volume_change";
	volume: number;
}

export interface WebviewVoiceChangeMessage {
	type: "voice_change";
	voice: string;
}

export interface WebviewMuteToggleMessage {
	type: "mute_toggle";
}

export interface WebviewRestartMessage {
	type: "restart";
}

export interface WebviewNextHighlightMessage {
	type: "next_highlight";
}

export interface WebviewPrevHighlightMessage {
	type: "prev_highlight";
}

export interface WebviewPlaybackCompleteMessage {
	type: "playback_complete";
}

export interface WebviewChunkPlayedMessage {
	type: "chunk_played";
}

export interface WebviewSaveMessage {
	type: "save";
}

export interface WebviewLoadMessage {
	type: "load";
	name: string;
}

export interface WebviewRequestSavedListMessage {
	type: "request_saved_list";
}

export interface WebviewCloseWalkthroughMessage {
	type: "close_walkthrough";
}

export interface WebviewDecisionAnswerMessage {
	type: "decision_answer";
	id: string;
	answer: string;
}

export interface WebviewOpenHandoffMessage {
	type: "open_handoff";
	path: string;
}

export interface WebviewRequestDecisionsMessage {
	type: "request_decisions";
}

export interface WebviewRequestFeedMessage {
	type: "request_feed";
}

export interface WebviewClearFeedMessage {
	type: "clear_feed";
}

export interface WebviewOpenDecisionsPanelMessage {
	type: "open_decisions_panel";
}

export interface WebviewOpenTheaterMessage {
	type: "open_theater";
}

export type FromWebviewMessage =
	| WebviewDecisionAnswerMessage
	| WebviewOpenHandoffMessage
	| WebviewRequestDecisionsMessage
	| WebviewRequestFeedMessage
	| WebviewClearFeedMessage
	| WebviewOpenDecisionsPanelMessage
	| WebviewOpenTheaterMessage
	| WebviewPlayPauseMessage
	| WebviewNextMessage
	| WebviewPrevMessage
	| WebviewGotoSegmentMessage
	| WebviewSpeedChangeMessage
	| WebviewVolumeChangeMessage
	| WebviewVoiceChangeMessage
	| WebviewMuteToggleMessage
	| WebviewRestartMessage
	| WebviewPlaybackCompleteMessage
	| WebviewChunkPlayedMessage
	| WebviewNextHighlightMessage
	| WebviewPrevHighlightMessage
	| WebviewSaveMessage
	| WebviewLoadMessage
	| WebviewRequestSavedListMessage
	| WebviewCloseWalkthroughMessage;
