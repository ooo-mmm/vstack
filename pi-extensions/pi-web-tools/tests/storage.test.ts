import assert from "node:assert/strict";
import test from "node:test";
import { clearMemoryForTests, getWebContent, restoreStoredContent, storeWebContent } from "../src/storage.js";
import { createGetWebContentToolDefinition } from "../src/tools/get-web-content.js";

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
