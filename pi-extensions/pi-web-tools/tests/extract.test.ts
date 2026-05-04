import assert from "node:assert/strict";
import test from "node:test";
import { parseGitHubUrl, extractGitHubUrl } from "../src/extract/github.js";
import { fetchHttpContent, htmlToMarkdown } from "../src/extract/http.js";
import { extractPdfText } from "../src/extract/pdf.js";

function response(body: string, headers: Record<string, string> = {}, status = 200): Response {
	return new Response(body, { status, headers });
}

test("HTML extraction removes chrome and keeps readable links", () => {
	const extracted = htmlToMarkdown("<html><head><title>T</title><style>x</style></head><body><nav><ul><li></li><li>Nav</li></ul></nav><main><h1>Hello</h1><p>See <a href=\"https://example.com\">Example</a></p><p>-</p></main><footer>Footer</footer><script>bad()</script></body></html>");
	assert.equal(extracted.title, "T");
	assert.match(extracted.markdown, /# Hello/);
	assert.match(extracted.markdown, /Example \(https:\/\/example\.com\)/);
	assert.doesNotMatch(extracted.markdown, /bad/);
	assert.doesNotMatch(extracted.markdown, /Nav|Footer/);
	assert.doesNotMatch(extracted.markdown, /^-$/m);
});

test("HTTP fetch extracts HTML and JSON", async () => {
	const htmlFetch = (async () => response("<title>Doc</title><p>Body</p>", { "content-type": "text/html" })) as typeof fetch;
	const html = await fetchHttpContent("https://example.com", { fetchImpl: htmlFetch });
	assert.equal(html.title, "Doc");
	assert.match(html.content, /Body/);
	const jsonFetch = (async () => response('{"b":2}', { "content-type": "application/json" })) as typeof fetch;
	const json = await fetchHttpContent("https://example.com/data.json", { fetchImpl: jsonFetch });
	assert.match(json.content, /"b": 2/);
});

test("PDF extraction reads simple text-bearing PDF streams", () => {
	const pdf = "%PDF-1.4\nBT\n(Hello PDF) Tj\n[( chunk) 20 ( two)] TJ\nET";
	const extracted = extractPdfText(pdf);
	assert.match(extracted.text, /Hello PDF/);
	assert.match(extracted.text, /chunk two/);
});

test("GitHub URL parser covers repo, blob, tree, and commit", () => {
	assert.equal(parseGitHubUrl("https://github.com/o/r")?.kind, "repo");
	const blob = parseGitHubUrl("https://github.com/o/r/blob/main/src/index.ts");
	assert.equal(blob?.kind, "blob");
	assert.equal(blob?.rawUrl, "https://raw.githubusercontent.com/o/r/main/src/index.ts");
	assert.equal(parseGitHubUrl("https://github.com/o/r/tree/main/src")?.kind, "tree");
	assert.equal(parseGitHubUrl("https://github.com/o/r/commit/abc")?.kind, "commit");
});

test("GitHub blob extraction uses raw URL", async () => {
	const seen: string[] = [];
	const fetchImpl = (async (url: any) => {
		seen.push(String(url));
		return response("file contents");
	}) as typeof fetch;
	const extracted = await extractGitHubUrl("https://github.com/o/r/blob/main/a.txt", { fetchImpl });
	assert.equal(extracted?.content, "file contents");
	assert.equal(seen[0], "https://raw.githubusercontent.com/o/r/main/a.txt");
});
