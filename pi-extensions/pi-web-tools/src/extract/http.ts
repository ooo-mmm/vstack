export interface ExtractedContent {
	url: string;
	title?: string;
	content: string;
	contentType?: string;
	status?: number;
	metadata: Record<string, unknown>;
}

export interface HttpFetchOptions {
	fetchImpl?: typeof fetch;
	textMaxCharacters?: number;
	signal?: AbortSignal;
}

function decodeEntities(text: string): string {
	return text
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'");
}

export function htmlToMarkdown(html: string): { title?: string; markdown: string } {
	const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim();
	const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1]
		?? html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1]
		?? html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1]
		?? html;
	let body = main
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
		.replace(/<svg[\s\S]*?<\/svg>/gi, "")
		.replace(/<(header|nav|footer|aside)\b[\s\S]*?<\/\1>/gi, "")
		.replace(/<form\b[\s\S]*?<\/form>/gi, "")
		.replace(/<\/(h[1-6]|p|li|blockquote|pre|tr|div|section|article)>/gi, "\n")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<h1[^>]*>/gi, "\n# ")
		.replace(/<h2[^>]*>/gi, "\n## ")
		.replace(/<h3[^>]*>/gi, "\n### ")
		.replace(/<li[^>]*>/gi, "\n- ")
		.replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, label) => `${label.replace(/<[^>]+>/g, "").trim()} (${href})`)
		.replace(/<[^>]+>/g, " ");
	body = decodeEntities(body)
		.replace(/[ \t]+/g, " ")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line && line !== "-" && line !== "•")
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return { title: title ? decodeEntities(title) : undefined, markdown: body };
}

export function isProbablyPdf(url: string, contentType?: string): boolean {
	return /application\/pdf/i.test(contentType ?? "") || new URL(url).pathname.toLowerCase().endsWith(".pdf");
}

export async function fetchHttpContent(url: string, options: HttpFetchOptions = {}): Promise<ExtractedContent> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const response = await fetchImpl(url, { signal: options.signal });
	if (!response.ok) throw new Error(`HTTP fetch failed (${response.status}) for ${url}`);
	const contentType = response.headers.get("content-type") ?? undefined;
	const raw = await response.text();
	let title: string | undefined;
	let content = raw;
	let extraction = "text";
	if (/html/i.test(contentType ?? "") || /<html[\s>]/i.test(raw)) {
		const extracted = htmlToMarkdown(raw);
		title = extracted.title;
		content = extracted.markdown;
		extraction = "html-basic";
	} else if (/json/i.test(contentType ?? "")) {
		try { content = JSON.stringify(JSON.parse(raw), null, 2); extraction = "json"; }
		catch { extraction = "json-raw"; }
	}
	if (options.textMaxCharacters && content.length > options.textMaxCharacters) content = content.slice(0, options.textMaxCharacters);
	return { url, title, content, contentType, status: response.status, metadata: { extraction, contentType, status: response.status } };
}
