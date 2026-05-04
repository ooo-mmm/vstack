import assert from "node:assert/strict";
import test from "node:test";
import { clearMemoryForTests, getWebContent, restoreStoredContent, storeWebContent } from "../src/storage.js";
import { createGetWebContentToolDefinition } from "../src/tools/get-web-content.js";
import { buildWebFetchToolResult, createWebFetchToolDefinition, DEFAULT_WEB_FETCH_PREVIEW_CHARACTERS } from "../src/tools/web-fetch.js";

const theme = { fg: (_tone: string, text: string) => text, bold: (text: string) => text };

test("stored content can be restored from session custom entries", () => {
	clearMemoryForTests();
	const appended: any[] = [];
	const pi = { appendEntry(type: string, data: unknown) { appended.push({ type, data }); } } as any;
	const stored = storeWebContent(pi, { title: "T", url: "https://example.com", content: "Body" });
	assert.equal(getWebContent(stored.id)?.content, "Body");
	clearMemoryForTests();
	restoreStoredContent({ sessionManager: { getEntries: () => appended.map((entry) => ({ type: "custom", customType: entry.type, data: entry.data })) } } as any);
	assert.equal(getWebContent(stored.id)?.url, "https://example.com");
});

test("get_web_content renderer styles missing-id errors with tree guidance", () => {
	const tool = createGetWebContentToolDefinition();
	const component = tool.renderResult({ content: [{ type: "text", text: "Stored content id not found: https://example.com" }] }, {}, theme, { isError: true, args: { id: "https://example.com" } });
	const text = component.render(200).join("\n");
	assert.match(text, /Get Web Content \(Session\)/);
	assert.match(text, /Stored content id not found/);
	assert.match(text, /├─ content id https:\/\/example\.com/);
	assert.match(text, /URLs are not content ids/);
});

test("get_web_content renderer separates session retrieval from source provider", () => {
	const tool = createGetWebContentToolDefinition();
	const component = tool.renderResult({ details: { id: "web-123", title: "Example", url: "https://example.com", contentLength: 42, metadata: { provider: "exa" } } }, {}, theme, { args: { id: "web-123" } });
	const text = component.render(200).join("\n");
	assert.match(text, /Get Web Content \(Session\) Example · 42 chars/);
	assert.match(text, /content id web-123/);
	assert.match(text, /source Exa/);
});

test("web_fetch renderer shows resolved provider without requested auto suffix", () => {
	const tool = createWebFetchToolDefinition({} as any, () => ({}) as any);
	const pending = tool.renderCall({ url: "https://example.com", provider: "auto" }, theme, {}).render(200).join("\n");
	assert.match(pending, /Web Fetch \(Resolving…\)/);
	const complete = tool.renderResult({ details: { provider: "github", stored: [{ id: "web-123", title: "file.zig" }] } }, {}, theme, { args: { provider: "auto", url: "https://example.com" } }).render(200).join("\n");
	assert.match(complete, /Web Fetch \(GitHub\)/);
	assert.doesNotMatch(complete, /GitHub\/Auto/);
	assert.match(complete, /content id web-123/);
});

test("web_fetch returned text and details identify preview truncation and stored full text", () => {
	const result = buildWebFetchToolResult([{
		id: "web-long",
		title: "Long page",
		url: "https://example.com/long",
		content: "x".repeat(DEFAULT_WEB_FETCH_PREVIEW_CHARACTERS + 5),
		createdAt: "2026-01-01T00:00:00.000Z",
	}], "http");
	const text = result.content[0]!.text;
	assert.match(text, /Preview returned \(4000\/4005 chars shown\)/);
	assert.match(text, /Full extracted text is stored under content id\(s\): web-long/);
	assert.match(text, /\[preview 4000\/4005 chars; full text stored\]/);
	assert.match(text, /Use get_web_content with the content id for stored full text/);
	assert.equal(result.details.preview.truncated, true);
	assert.equal(result.details.preview.shownCharacters, 4000);
	assert.equal(result.details.preview.fullCharacters, 4005);
	assert.deepEqual(result.details.preview.items, [{ id: "web-long", shownCharacters: 4000, fullCharacters: 4005, truncated: true }]);
});

test("web_fetch renderer shows concise preview shown/full metadata when preview-truncated", () => {
	const tool = createWebFetchToolDefinition({} as any, () => ({}) as any);
	const result = buildWebFetchToolResult([{
		id: "web-long",
		title: "Long page",
		url: "https://example.com/long",
		content: "x".repeat(DEFAULT_WEB_FETCH_PREVIEW_CHARACTERS + 5),
		createdAt: "2026-01-01T00:00:00.000Z",
	}], "github");
	const rendered = tool.renderResult(result, {}, theme, { args: { provider: "auto", url: "https://example.com/long" } }).render(200).join("\n");
	assert.match(rendered, /Web Fetch \(GitHub\) https:\/\/example\.com\/long · 1 stored · preview 4000\/4005 chars/);
	assert.match(rendered, /content id web-long · preview 4000\/4005 chars/);
	assert.doesNotMatch(rendered, /GitHub\/Auto/);
});
