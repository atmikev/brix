// ── Navigator LLM providers ──
// Hand-rolled fetch clients (repo convention — see tts-bridge.ts). Global fetch
// exists at runtime: esbuild targets node18 and VS Code ^1.85 ships Node 18.

export interface NavTool {
	name: string;
	description: string;
	inputSchema: object;
}

export interface ToolCall {
	id: string;
	name: string;
	input: unknown;
	invalidJson?: string; // openai only: raw arguments string that failed JSON.parse
}

export type NavMessage =
	| { role: "user"; text: string }
	// raw = anthropic content blocks, replayed verbatim across tool turns
	// (dropping thinking blocks breaks tool loops on current Claude models)
	| { role: "assistant"; text: string; toolCalls: ToolCall[]; raw?: unknown[] }
	| { role: "toolResults"; results: { id: string; content: string; isError?: boolean }[] };

export interface ChatResult {
	text: string;
	toolCalls: ToolCall[];
	raw?: unknown[];
}

export type ChatFn = (
	system: string,
	messages: NavMessage[],
	tools: NavTool[],
	forceTool?: string,
) => Promise<ChatResult>;

export interface ProviderConfig {
	provider: string; // "anthropic" | "openai"
	model: string;
	baseUrl: string; // openai only
	apiKey: string; // may be empty (Ollama / LM Studio)
}

const REQUEST_TIMEOUT_MS = 120_000;

async function post(url: string, headers: Record<string, string>, body: object): Promise<any> {
	const res = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`${res.status} ${url}: ${text.slice(0, 300)}`);
	}
	return res.json();
}

// ── Anthropic /v1/messages ──

function anthropicChat(cfg: ProviderConfig): ChatFn {
	return async (system, messages, tools, forceTool) => {
		const apiMessages = messages.map((m) => {
			if (m.role === "user") return { role: "user", content: m.text };
			if (m.role === "assistant") {
				const content =
					m.raw ??
					[
						...(m.text ? [{ type: "text", text: m.text }] : []),
						...m.toolCalls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.input })),
					];
				return { role: "assistant", content };
			}
			return {
				role: "user",
				content: m.results.map((r) => ({
					type: "tool_result",
					tool_use_id: r.id,
					content: r.content,
					...(r.isError ? { is_error: true } : {}),
				})),
			};
		});

		const json = await post(
			"https://api.anthropic.com/v1/messages",
			{ "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" },
			{
				model: cfg.model,
				max_tokens: 16000,
				system,
				messages: apiMessages,
				tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
				...(forceTool ? { tool_choice: { type: "tool", name: forceTool } } : {}),
			},
		);

		const blocks: any[] = json.content ?? [];
		return {
			text: blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n"),
			toolCalls: blocks
				.filter((b) => b.type === "tool_use")
				.map((b) => ({ id: b.id, name: b.name, input: b.input })),
			raw: blocks,
		};
	};
}

// ── OpenAI-compatible /chat/completions (OpenAI, Ollama, LM Studio) ──

function openaiChat(cfg: ProviderConfig): ChatFn {
	return async (system, messages, tools, forceTool) => {
		const apiMessages: any[] = [{ role: "system", content: system }];
		for (const m of messages) {
			if (m.role === "user") {
				apiMessages.push({ role: "user", content: m.text });
			} else if (m.role === "assistant") {
				apiMessages.push({
					role: "assistant",
					content: m.text || null,
					...(m.toolCalls.length
						? {
								tool_calls: m.toolCalls.map((c) => ({
									id: c.id,
									type: "function",
									function: { name: c.name, arguments: c.invalidJson ?? JSON.stringify(c.input) },
								})),
							}
						: {}),
				});
			} else {
				for (const r of m.results) {
					apiMessages.push({ role: "tool", tool_call_id: r.id, content: r.content });
				}
			}
		}

		const base = cfg.baseUrl.replace(/\/+$/, "");
		const json = await post(
			`${base}/chat/completions`,
			cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {},
			{
				model: cfg.model,
				messages: apiMessages,
				tools: tools.map((t) => ({
					type: "function",
					function: { name: t.name, description: t.description, parameters: t.inputSchema },
				})),
				...(forceTool ? { tool_choice: { type: "function", function: { name: forceTool } } } : {}),
			},
		);

		const msg = json.choices?.[0]?.message ?? {};
		const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((c: any, i: number) => {
			const id = c.id || `call_${i}`;
			const name = c.function?.name ?? "";
			try {
				return { id, name, input: JSON.parse(c.function?.arguments || "{}") };
			} catch {
				return { id, name, input: {}, invalidJson: String(c.function?.arguments ?? "") };
			}
		});
		return { text: typeof msg.content === "string" ? msg.content : "", toolCalls };
	};
}

export function makeProvider(cfg: ProviderConfig): ChatFn {
	return cfg.provider === "anthropic" ? anthropicChat(cfg) : openaiChat(cfg);
}
