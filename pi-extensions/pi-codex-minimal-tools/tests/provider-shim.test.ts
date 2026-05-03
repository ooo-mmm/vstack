import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { convertMessages, synthesizeNativeToolEvents } from "../src/provider-shim.js";

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const item of iterable) out.push(item);
	return out;
}

test("synthesizeNativeToolEvents saves image_generation_call output and emits text", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-native-image-"));
	const events = collect(synthesizeNativeToolEvents((async function* () {
		yield { type: "response.created", response: { id: "resp_1" } };
		yield { type: "response.output_item.done", item: { type: "image_generation_call", id: "img_1", result: Buffer.from("png").toString("base64"), output_format: "png" } };
	})(), cwd));
	const output = await events;
	assert.equal(output[0]?.type, "response.created");
	const messageStart = output.find((event) => event.type === "response.output_item.added" && (event as any).item?.type === "message") as any;
	assert.ok(messageStart?.item?.id?.startsWith("msg"));
	assert.ok(output.some((event) => event.type === "response.output_text.delta" && String(event.delta).includes("Generated image saved")));
	const delta = output.find((event) => event.type === "response.output_text.delta")?.delta as string;
	const match = delta.match(/saved to (.+?) \(latest:/);
	assert.ok(match?.[1]);
	assert.ok(existsSync(match[1]));
});


function findStatusDelta(events: Record<string, unknown>[]): string | undefined {
	for (const event of events) {
		if (event.type !== "response.output_text.delta") continue;
		const delta = String((event as Record<string, unknown>).delta ?? "");
		if (delta.startsWith("[web_search]")) return delta;
	}
	return undefined;
}

test("synthesizeNativeToolEvents emits concise web search status text", async () => {
	const output = await collect(synthesizeNativeToolEvents((async function* () {
		yield {
			type: "response.output_item.done",
			item: {
				type: "web_search_call",
				id: "web_1",
				action: {
					type: "search",
					queries: ["Pi coding agent"],
					sources: [{ type: "url", url: "https://docs.pi.dev/search" }, { type: "url", url: "https://www.example.com/a" }],
				},
			},
		};
	})()));
	assert.equal(output.find((event) => event.type === "response.output_item.added" && (event as any).item?.name === "web_search"), undefined, "no synthetic toolCall block expected");
	const status = findStatusDelta(output);
	assert.ok(status, "expected synthetic status text");
	assert.match(String(status), /Pi coding agent/);
	assert.match(String(status), /docs\.pi\.dev/);
	assert.match(String(status), /example\.com/);
});

test("synthesizeNativeToolEvents falls back to web_search_call.completed when output_item.done is absent", async () => {
	const output = await collect(synthesizeNativeToolEvents((async function* () {
		yield { type: "response.web_search_call.in_progress", item_id: "ws_only_completed" };
		yield { type: "response.web_search_call.completed", item_id: "ws_only_completed" };
		yield { type: "response.output_text.annotation.added", annotation: { type: "url_citation", url: "https://reuters.com/article", title: "Reuters" } };
		yield { type: "response.completed", response: { status: "completed" } };
	})()));
	const status = findStatusDelta(output);
	assert.ok(status, "expected fallback synthesis from web_search_call.completed");
	assert.match(String(status), /reuters\.com/);
});

test("synthesizeNativeToolEvents prefers output_item.done data when both events fire", async () => {
	const output = await collect(synthesizeNativeToolEvents((async function* () {
		yield { type: "response.web_search_call.completed", item_id: "ws_both" };
		yield {
			type: "response.output_item.done",
			item: {
				type: "web_search_call",
				id: "ws_both",
				action: { type: "search", queries: ["q"], sources: [{ type: "url", url: "https://reuters.com/x" }] },
			},
		};
		yield { type: "response.completed", response: { status: "completed" } };
	})()));
	const statuses = output.filter((event) => event.type === "response.output_text.delta" && String((event as any).delta).startsWith("[web_search]"));
	assert.equal(statuses.length, 1);
	assert.match(String((statuses[0] as any).delta), /reuters\.com/);
});

test("synthesizeNativeToolEvents extracts sites from action.sources URLs", async () => {
	const output = await collect(synthesizeNativeToolEvents((async function* () {
		yield {
			type: "response.output_item.done",
			item: {
				type: "web_search_call",
				id: "ws_action",
				status: "completed",
				action: {
					type: "search",
					queries: ["latest news"],
					sources: [
						{ type: "url", url: "https://www.reuters.com/world/foo" },
						{ type: "url", url: "https://apnews.com/article/bar" },
					],
				},
			},
		};
	})()));
	const status = findStatusDelta(output);
	assert.match(String(status), /latest news/);
	assert.match(String(status), /apnews\.com/);
	assert.match(String(status), /reuters\.com/);
});

test("synthesizeNativeToolEvents adds citation footer for unseen url_citation hosts", async () => {
	const output = await collect(synthesizeNativeToolEvents((async function* () {
		yield {
			type: "response.output_item.done",
			item: {
				type: "web_search_call",
				id: "ws_cited",
				action: { type: "search", queries: ["q"], sources: [{ type: "url", url: "https://reuters.com/x" }] },
			},
		};
		yield { type: "response.output_text.annotation.added", annotation: { type: "url_citation", url: "https://apnews.com/y", title: "AP" } };
		yield { type: "response.output_text.annotation.added", annotation: { type: "url_citation", url: "https://reuters.com/z", title: "Reuters" } };
		yield { type: "response.completed", response: { status: "completed" } };
	})()));
	const citationDelta = output.find((event) => event.type === "response.output_text.delta" && /Cited sources/.test(String((event as any).delta))) as any;
	assert.ok(citationDelta, "expected a Cited sources synthetic text delta");
	assert.match(String(citationDelta.delta), /apnews\.com/);
	assert.doesNotMatch(String(citationDelta.delta), /reuters\.com/);
});

test("synthesizeNativeToolEvents skips citation footer when no new hosts beyond action.sources", async () => {
	const output = await collect(synthesizeNativeToolEvents((async function* () {
		yield {
			type: "response.output_item.done",
			item: {
				type: "web_search_call",
				id: "ws_no_extra",
				action: { type: "search", queries: ["q"], sources: [{ type: "url", url: "https://reuters.com/x" }] },
			},
		};
		yield { type: "response.output_text.annotation.added", annotation: { type: "url_citation", url: "https://reuters.com/y", title: "Reuters" } };
		yield { type: "response.completed", response: { status: "completed" } };
	})()));
	assert.equal(output.find((event) => event.type === "response.output_text.delta" && /Cited sources/.test(String((event as any).delta))), undefined);
});

test("synthesizeNativeToolEvents emits status text without sources when provider omits them", async () => {
	const output = await collect(synthesizeNativeToolEvents((async function* () {
		yield { type: "response.output_item.done", item: { type: "web_search_call", id: "web_empty", action: { type: "search", queries: ["No sites"] } } };
	})()));
	const status = findStatusDelta(output);
	assert.ok(status, "expected synthetic status text");
	assert.doesNotMatch(String(status), /Sources:/);
});

test("convertMessages drops native web_search status text blocks with JSON-form signature", () => {
	const messages = convertMessages({} as any, {
		messages: [
			{ role: "assistant", content: [{ type: "text", text: "Web search completed for: Pi.", textSignature: JSON.stringify({ v: 1, id: "msg_vstack_web_status_0" }) }] },
			{ role: "user", content: "next" },
		],
	} as any);
	assert.deepEqual(messages, [{ role: "user", content: [{ type: "input_text", text: "next" }] }]);
});

test("convertMessages drops native web_search status text blocks", () => {
	const messages = convertMessages({} as any, {
		messages: [
			{ role: "assistant", content: [{ type: "text", text: "Web search completed for: Pi. Sources: docs.pi.dev.", textSignature: "vstack:native-web-search-status" }] },
			{ role: "user", content: "next" },
		],
	} as any);
	assert.deepEqual(messages, [{ role: "user", content: [{ type: "input_text", text: "next" }] }]);
});

test("convertMessages drops synthetic native web_search UI calls and results", () => {
	const messages = convertMessages({} as any, {
		messages: [
			{ role: "assistant", content: [{ type: "toolCall", id: "vstack-web|fc_ws_0e7d68", name: "web_search", arguments: { _vstackNativeWebStatus: true, query: "Pi" } }] },
			{ role: "toolResult", toolCallId: "vstack-web|fc_ws_0e7d68", content: [{ type: "text", text: JSON.stringify({ type: "vstack_web_search_status", query: "Pi", sites: [] }) }] },
			{ role: "user", content: "next" },
		],
	} as any);
	assert.deepEqual(messages, [{ role: "user", content: [{ type: "input_text", text: "next" }] }]);
});

test("convertMessages normalizes non-fc function_call item ids", () => {
	const messages = convertMessages({} as any, {
		messages: [
			{ role: "assistant", content: [{ type: "toolCall", id: "call_1|ws_bad", name: "read", arguments: { path: "README.md" } }] },
		],
	} as any) as any[];
	assert.equal(messages[0].type, "function_call");
	assert.equal(messages[0].call_id, "call_1");
	assert.ok(messages[0].id.startsWith("fc"));
});

test("convertMessages inserts fallback output for dangling tool calls before next user", () => {
	const messages = convertMessages({} as any, {
		messages: [
			{ role: "assistant", content: [{ type: "toolCall", id: "call_missing|fc_missing", name: "read", arguments: { path: "README.md" } }] },
			{ role: "user", content: "continue" },
		],
	} as any) as any[];
	assert.equal(messages[0].type, "function_call");
	assert.deepEqual(messages[1], { type: "function_call_output", call_id: "call_missing", output: "No result provided for read." });
	assert.deepEqual(messages[2], { role: "user", content: [{ type: "input_text", text: "continue" }] });
});

test("convertMessages does not insert fallback when tool result exists", () => {
	const messages = convertMessages({} as any, {
		messages: [
			{ role: "assistant", content: [{ type: "toolCall", id: "call_ok|fc_ok", name: "read", arguments: { path: "README.md" } }] },
			{ role: "toolResult", toolCallId: "call_ok|fc_ok", content: [{ type: "text", text: "done" }] },
			{ role: "user", content: "continue" },
		],
	} as any) as any[];
	assert.deepEqual(messages.map((item) => item.type ?? item.role), ["function_call", "function_call_output", "user"]);
	assert.equal(messages[1].call_id, "call_ok");
	assert.equal(messages[1].output, "done");
});

test("convertMessages skips aborted and errored assistant turns", () => {
	const messages = convertMessages({} as any, {
		messages: [
			{ role: "assistant", stopReason: "aborted", content: [{ type: "toolCall", id: "call_aborted|fc_aborted", name: "read", arguments: {} }] },
			{ role: "toolResult", toolCallId: "call_aborted|fc_aborted", content: [{ type: "text", text: "late result" }] },
			{ role: "assistant", stopReason: "error", content: [{ type: "text", text: "partial" }] },
			{ role: "user", content: "next" },
		],
	} as any) as any[];
	assert.deepEqual(messages, [{ role: "user", content: [{ type: "input_text", text: "next" }] }]);
});

test("convertMessages preserves real prose that happens to start like web-search status", () => {
	const text = "Web search completed because I manually typed that phrase.";
	const messages = convertMessages({} as any, {
		messages: [{ role: "assistant", content: [{ type: "text", text }] }],
	} as any) as any[];
	assert.equal(messages[0].type, "message");
	assert.equal(messages[0].content[0].text, text);
});

test("convertMessages only skips native web_search result by skipped call id", () => {
	const messages = convertMessages({} as any, {
		messages: [
			{ role: "assistant", content: [{ type: "toolCall", id: "call_real|fc_real", name: "read", arguments: {} }] },
			{ role: "toolResult", toolCallId: "call_real|fc_real", content: [{ type: "text", text: '{"vstack_web_search_status":true,"note":"real tool output"}' }] },
		],
	} as any) as any[];
	assert.equal(messages[1].type, "function_call_output");
	assert.equal(messages[1].output, '{"vstack_web_search_status":true,"note":"real tool output"}');
});

test("convertMessages sanitizes foreign provider function call ids consistently", () => {
	const longForeignCallId = `foreign provider|${"x".repeat(80)}`;
	const messages = convertMessages({} as any, {
		messages: [
			{ role: "assistant", content: [{ type: "toolCall", id: longForeignCallId, name: "read", arguments: {} }] },
			{ role: "toolResult", toolCallId: longForeignCallId, content: [{ type: "text", text: "ok" }] },
		],
	} as any) as any[];
	assert.match(messages[0].call_id, /^[A-Za-z0-9_-]{1,64}$/);
	assert.equal(messages[1].call_id, messages[0].call_id);
	assert.match(messages[0].id, /^[A-Za-z0-9_-]{1,64}$/);
});
