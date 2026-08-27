#!/usr/bin/env node
// Mock OpenAI-compatible server for exercising the navigator with zero API cost.
// Usage:  node scripts/mock-openai.js          # happy path
//         MOCK_BAD=1 node scripts/mock-openai.js  # invalid deliver → degrade path
// Point the extension at it: brix.navigator.provider=openai,
// baseUrl=http://localhost:3999/v1, any model, no key. Then run
// "Brix: Navigator — Review Working Tree Diff" in the brix repo itself.

const http = require("http");

const BAD = !!process.env.MOCK_BAD;

const goodDeliver = {
	title: "Mock review of brix",
	verdict:
		"This is a canned verdict from the mock server. Two anchored points, one finding, and one question follow.",
	utterances: [
		{
			kind: "say",
			title: "Project intro",
			file: "CONTEXT.md",
			start: 1,
			end: 5,
			spoken: "This is the project context file. It describes voice narrated walkthroughs driven from the editor.",
			detail: "**Mock detail** for the first segment.",
		},
		{
			kind: "say",
			title: "Architecture sketch",
			file: "CONTEXT.md",
			start: 37,
			end: 44,
			spoken: "Here the architecture diagram shows the agent talking to the extension over an HTTP bus.",
		},
		{ kind: "finding", title: "Mock side finding", detail: "A cross-cutting observation not tied to one location." },
		{
			kind: "question",
			title: "Mock question: proceed?",
			detail: "The mock navigator wants a verdict.",
			options: [{ label: "Yes", recommended: true }, { label: "No" }],
		},
	],
};

const badDeliver = { title: "", utterances: "not-an-array" };

function toolCallMsg(id, name, args) {
	return {
		choices: [
			{
				message: {
					role: "assistant",
					content: null,
					tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
				},
			},
		],
	};
}

const server = http.createServer((req, res) => {
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", () => {
		if (!req.url.endsWith("/chat/completions")) {
			res.writeHead(404).end("{}");
			return;
		}
		const request = JSON.parse(body);
		const toolTurns = request.messages.filter((m) => m.role === "tool").length;
		console.log(`[mock] call with ${request.messages.length} messages (${toolTurns} tool results)`);

		let reply;
		if (toolTurns === 0) {
			reply = toolCallMsg("call_read", "read_file", { path: "CONTEXT.md", start: 1, end: 50 });
		} else {
			reply = toolCallMsg("call_deliver", "deliver", BAD ? badDeliver : goodDeliver);
		}
		res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply));
	});
});

server.listen(3999, () => console.log(`[mock] OpenAI-compatible server on http://localhost:3999/v1 (${BAD ? "BAD deliver" : "happy path"})`));
