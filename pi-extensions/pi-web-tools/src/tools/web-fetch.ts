import { fileURLToPath, pathToFileURL } from "node:url";
import { basename, isAbsolute, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { extractGitHubUrl } from "../extract/github.js";
import { fetchHttpContent, isProbablyPdf } from "../extract/http.js";
import { extractLocalVideo, isLocalVideoPath } from "../extract/video.js";
import { extractYouTubeUrl, parseYouTubeUrl } from "../extract/youtube.js";
import { readFile as fsReadFile } from "node:fs/promises";
import { fetchLocalPdfText, fetchPdfText, extractPdfTextBest } from "../extract/pdf.js";
import { looksLikeScannedPdf, rasterizePdfPages, type PdfPageImage } from "../extract/pdf-pages.js";
import { ExaClient } from "../providers/exa.js";
import type { WebToolsSettings } from "../settings.js";
import { storeWebContent, type StoredWebContent } from "../storage.js";
import { truncateText } from "../utils/format.js";
import { accent, emptyComponent, errorSummary, firstText, muted, providerLabel, successSummary, textComponent, tree, webCallText } from "../utils/render.js";

export const webFetchSchema = Type.Object({
	url: Type.Optional(Type.String()),
	urls: Type.Optional(Type.Array(Type.String())),
	filePath: Type.Optional(Type.String({ description: "Local file path to extract. Currently supports PDFs. Relative paths resolve against ctx.cwd; leading @ is stripped." })),
	filePaths: Type.Optional(Type.Array(Type.String({ description: "Local file paths to extract. Currently supports PDFs." }))),
	textMaxCharacters: Type.Optional(Type.Number({ description: "Preview character cap for direct/GitHub/PDF fetches and provider extraction cap for Exa fallback/override. Direct fetches still store the full extracted text in session storage before preview truncation." })),
	provider: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("http"), Type.Literal("exa")])),
	prompt: Type.Optional(Type.String({ description: "Optional prompt for video/YouTube understanding (passed to Gemini Web/API). Ignored for non-video URLs." })),
});
export type WebFetchInput = Static<typeof webFetchSchema>;

export const DEFAULT_WEB_FETCH_PREVIEW_CHARACTERS = 4000;

interface WebFetchPreviewItem {
	id: string;
	shownCharacters: number;
	fullCharacters: number;
	truncated: boolean;
}

interface WebFetchPreviewDetails {
	maxCharacters: number;
	shownCharacters: number;
	fullCharacters: number;
	truncated: boolean;
	items: WebFetchPreviewItem[];
}

function fallbackTitle(url: string | undefined, fallback = "content"): string {
	if (!url) return fallback;
	try {
		const parsed = new URL(url);
		const leaf = parsed.pathname.split("/").filter(Boolean).pop();
		return leaf || parsed.hostname || url;
	} catch {
		return url.split("/").filter(Boolean).pop() || url || fallback;
	}
}

function displayTitle(item: { title?: string; url?: string; id?: string }): string {
	return item.title?.trim() || fallbackTitle(item.url, item.id || "content");
}

function urls(params: WebFetchInput): string[] {
	const items = [...(params.urls ?? []), ...(params.filePaths ?? [])];
	if (params.url) items.unshift(params.url);
	if (params.filePath) items.unshift(params.filePath);
	return items.map((url) => url.trim()).filter(Boolean);
}

function cleanPath(path: string): string {
	return path.startsWith("@") ? path.slice(1) : path;
}

function isLocalFileInput(input: string): boolean {
	if (input.startsWith("file://")) return true;
	const cleaned = cleanPath(input);
	if (isAbsolute(cleaned)) return true;
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(cleaned)) return false;
	return isProbablyPdf(cleaned);
}

function resolveLocalFilePath(cwd: string, input: string): string {
	if (input.startsWith("file://")) return fileURLToPath(input);
	const cleaned = cleanPath(input);
	return isAbsolute(cleaned) ? cleaned : resolve(cwd, cleaned);
}

function fetchProviderForLabel(requested: unknown, actual?: unknown): string {
	const requestedValue = String(requested ?? "auto").trim().toLowerCase() || "auto";
	const actualValue = String(actual ?? requestedValue).trim().toLowerCase() || requestedValue;
	return actualValue;
}

function pendingFetchProviderForLabel(requested: unknown): string {
	return String(requested ?? "auto").trim().toLowerCase() === "auto" ? "resolving…" : fetchProviderForLabel(requested);
}

function storedProviderLabel(item: any): string {
	const provider = String(item?.metadata?.provider ?? "").trim().toLowerCase();
	const chain = Array.isArray(item?.metadata?.extractionChain) ? item.metadata.extractionChain.map((x: unknown) => String(x).toLowerCase()) : [];
	const usedJina = chain.includes("jina");
	if (provider === "http" && usedJina) return "http+jina";
	if (provider === "local") return "local";
	return provider || "http";
}

function storedProvider(stored: any[]): string {
	const labels = Array.from(new Set(stored.map(storedProviderLabel).filter(Boolean)));
	if (labels.length === 0) return "http";
	return labels.length === 1 ? labels[0]! : "mixed";
}

function previewLimit(params: WebFetchInput): number {
	const raw = params.textMaxCharacters ?? DEFAULT_WEB_FETCH_PREVIEW_CHARACTERS;
	return Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : DEFAULT_WEB_FETCH_PREVIEW_CHARACTERS;
}

function previewStats(content: string, maxCharacters: number): WebFetchPreviewItem {
	const fullCharacters = content.length;
	return {
		id: "",
		shownCharacters: Math.min(fullCharacters, Math.max(0, maxCharacters)),
		fullCharacters,
		truncated: fullCharacters > maxCharacters,
	};
}

export function buildWebFetchToolResult(stored: StoredWebContent[], provider: string, maxCharacters = DEFAULT_WEB_FETCH_PREVIEW_CHARACTERS, pageImages: Array<{ type: "image"; mimeType: string; data: string; pageNumber?: number }> = []) {
	const previewItems = stored.map((item) => {
		const stats = previewStats(item.content, maxCharacters);
		const { text } = truncateText(item.content, maxCharacters);
		return { item, text, stats: { ...stats, id: item.id } };
	});
	const preview: WebFetchPreviewDetails = {
		maxCharacters,
		shownCharacters: previewItems.reduce((sum, item) => sum + item.stats.shownCharacters, 0),
		fullCharacters: previewItems.reduce((sum, item) => sum + item.stats.fullCharacters, 0),
		truncated: previewItems.some((item) => item.stats.truncated),
		items: previewItems.map((item) => item.stats),
	};
	const ids = stored.map((item) => item.id).join(", ");
	const previewText = previewItems.map(({ item, text, stats }) => {
		const label = displayTitle(item);
		const meta = `preview ${stats.shownCharacters}/${stats.fullCharacters} chars${stats.truncated ? "; full text stored" : ""}`;
		return `- ${item.id}: ${label}\n[${meta}]\n${text}`;
	}).join("\n\n");
	const previewMeta = preview.truncated ? ` (${preview.shownCharacters}/${preview.fullCharacters} chars shown)` : "";
	const imagesNote = pageImages.length ? `\n\n[${pageImages.length} scanned PDF page image${pageImages.length === 1 ? "" : "s"} attached for vision OCR]` : "";
	const content: Array<{ type: "text"; text: string } | { type: "image"; mimeType: string; data: string }> = [
		{ type: "text", text: `Fetched ${stored.length} URL(s). Preview returned${previewMeta}. Full extracted text is stored under content id(s): ${ids || "none"}.\n\n${previewText}${imagesNote}\n\nUse get_web_content with the content id for stored full text.` },
	];
	for (const image of pageImages) content.push({ type: "image", mimeType: image.mimeType, data: image.data });
	return {
		content,
		details: { provider, stored, preview, pageImageCount: pageImages.length },
	};
}

export function createWebFetchToolDefinition(pi: ExtensionAPI, getSettings: (cwd?: string) => WebToolsSettings, name = "web_fetch") {
	return {
		renderShell: "self" as const,
		name,
		label: name === "web_fetch" ? "Web Fetch" : "Fetch Content",
		description: "Fetch known URL or local PDF content and store full extracted text for get_web_content. Auto handles GitHub, PDF, HTML/text/JSON, with Exa contents fallback/override for URLs. Direct/GitHub/PDF fetches store full extracted text; the tool result is only a preview.",
		promptSnippet: "Fetch and store known URL or local PDF content; use the returned content id with get_web_content for full stored text.",
		parameters: webFetchSchema,
		renderCall(args: WebFetchInput, theme: any, context: any) {
			if (context?.executionStarted && !context?.isPartial) return emptyComponent();
			const list = urls(args);
			return textComponent(webCallText(theme, providerLabel(name === "web_fetch" ? "Web Fetch" : name, pendingFetchProviderForLabel(args?.provider)), list[0] ?? "url", list.length > 1 ? `+${list.length - 1} urls` : undefined));
		},
		renderResult(result: any, options: any, theme: any, context: any) {
			if (options?.isPartial) return emptyComponent();
			if (context?.isError) return textComponent(errorSummary(theme, providerLabel(name === "web_fetch" ? "Web Fetch" : name, fetchProviderForLabel(context?.args?.provider)), firstText(result) || "failed"));
			const stored = Array.isArray(result?.details?.stored) ? result.details.stored : [];
			const provider = fetchProviderForLabel(context?.args?.provider, result?.details?.provider);
			const preview = result?.details?.preview;
			const meta = [`${stored.length} stored`, preview?.truncated ? `preview ${preview.shownCharacters}/${preview.fullCharacters} chars` : undefined].filter(Boolean).join(" · ");
			const target = context?.args?.url || context?.args?.urls?.[0] || context?.args?.filePath || context?.args?.filePaths?.[0] || "content";
			const lines = [successSummary(theme, providerLabel(name === "web_fetch" ? "Web Fetch" : name, provider), target, meta)];
			for (let index = 0; index < stored.slice(0, 3).length; index++) {
				const item = stored[index]!;
				const itemPreview = Array.isArray(preview?.items) ? preview.items.find((candidate: any) => candidate?.id === item.id) : undefined;
				const suppressLeafPreview = stored.length === 1 && preview?.truncated;
				const previewMeta = !suppressLeafPreview && itemPreview?.truncated ? `preview ${itemPreview.shownCharacters}/${itemPreview.fullCharacters} chars` : "";
				const cachePath = typeof item?.metadata?.cachePath === "string" ? item.metadata.cachePath : undefined;
				const itemMeta = [item.url, previewMeta || undefined].filter(Boolean).join(" · ");
				const hasCache = Boolean(cachePath);
				const connector = index === stored.length - 1 && !hasCache ? "└" : "├";
				lines.push(`${tree(theme, connector)}${accent(theme, displayTitle(item))}${itemMeta ? muted(theme, ` · ${itemMeta}`) : ""}`);
				if (cachePath) lines.push(`${tree(theme, index === stored.length - 1 ? "└" : "├")}${muted(theme, "cached at ")}${accent(theme, cachePath)}`);
			}
			if (stored.length > 3) lines.push(`${tree(theme, "└")}${muted(theme, `… ${stored.length - 3} more`)}`);
			return textComponent(lines.join("\n"));
		},
		async execute(_toolCallId: string, params: WebFetchInput, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
			const settings = getSettings(ctx.cwd);
			const list = urls(params);
			if (list.length === 0) throw new Error(`${name} requires url/urls or filePath/filePaths.`);
			if (params.provider === "exa" && list.some(isLocalFileInput)) throw new Error("provider=exa can only fetch remote URLs. Use provider=auto or provider=http for local PDF paths.");
			async function fetchWithExa(failedUrls: string[]) {
				const client = new ExaClient({ apiKey: settings.apiKeys.exa });
				const response = await client.contents({ urls: failedUrls, textMaxCharacters: params.textMaxCharacters }, signal);
				return response.results.map((result) => storeWebContent(pi, { title: result.title?.trim() || fallbackTitle(result.url), url: result.url, content: result.text || result.summary || "", metadata: { provider: "exa", tool: name } }));
			}
			if (params.provider !== "exa") {
				const stored = [];
				const pageImages: PdfPageImage[] = [];
				const failed: Array<{ url: string; error: unknown }> = [];
				async function handlePdfBuffer(buffer: Buffer | ArrayBuffer | Uint8Array, source: { provider: "http" | "local"; url: string; title: string; localPath?: string }) {
					const bufferLike = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer));
					let text = "";
					let textMeta: Record<string, unknown> = {};
					try {
						const result = await extractPdfTextBest(bufferLike);
						text = result.text;
						textMeta = result.metadata;
					} catch (error) {
						textMeta = { extraction: "pdf-empty", textError: error instanceof Error ? error.message : String(error) };
					}
					let rasterized: { pageCount: number; truncated: boolean } | undefined;
					if (settings.pdfOcr.enabled && looksLikeScannedPdf(text, bufferLike.byteLength)) {
						try {
							const result = await rasterizePdfPages(bufferLike, { maxPages: settings.pdfOcr.maxPages, dpi: settings.pdfOcr.dpi });
							rasterized = { pageCount: result.pageCount, truncated: result.truncated };
							for (const image of result.images) pageImages.push(image);
						} catch (error) {
							textMeta = { ...textMeta, ocrError: error instanceof Error ? error.message : String(error) };
						}
					}
					const content = text || (rasterized ? `[Scanned PDF: ${rasterized.pageCount} pages, ${pageImages.length} attached as images${rasterized.truncated ? ` (truncated to ${settings.pdfOcr.maxPages})` : ""}]` : "[Empty PDF: no extractable text]");
					const metadata = { provider: source.provider, tool: name, ...textMeta, ...(source.localPath ? { localPath: source.localPath } : {}), ...(rasterized ? { pdfPageCount: rasterized.pageCount, pdfPagesRasterized: pageImages.length, pdfPagesTruncated: rasterized.truncated } : {}) };
					stored.push(storeWebContent(pi, { title: source.title, url: source.url, content, metadata }));
				}
				for (const url of list) {
					try {
						if (isLocalFileInput(url)) {
							const localPath = resolveLocalFilePath(ctx.cwd, url);
							if (settings.video.enabled && isLocalVideoPath(localPath)) {
								const video = await extractLocalVideo(localPath, { prompt: params.prompt, geminiApiKey: settings.apiKeys.gemini, signal });
								stored.push(storeWebContent(pi, { title: video.title, url: pathToFileURL(localPath).href, content: video.content, metadata: { tool: name, localPath, ...video.metadata } }));
								continue;
							}
							if (!isProbablyPdf(localPath)) throw new Error(`Local file extraction currently supports PDFs and videos only: ${localPath}`);
							const buffer = await fsReadFile(localPath);
							await handlePdfBuffer(buffer, { provider: "local", url: pathToFileURL(localPath).href, title: basename(localPath), localPath });
							continue;
						}
						const github = await extractGitHubUrl(url, { signal, cloneEnabled: settings.githubClone.enabled, maxRepoSizeMB: settings.githubClone.maxRepoSizeMB, cloneTimeoutSeconds: settings.githubClone.cloneTimeoutSeconds, maxAgeHours: settings.githubClone.cacheMaxAgeHours }).catch((error) => ({ error }));
						if (github && !("error" in github)) {
							stored.push(storeWebContent(pi, { title: github.title, url, content: github.content, metadata: github.metadata }));
							continue;
						}
						if (settings.video.enabled && parseYouTubeUrl(url)) {
							const yt = await extractYouTubeUrl(url, { prompt: params.prompt, geminiApiKey: settings.apiKeys.gemini, browserCookies: { preferredBrowser: settings.browserCookies.preferredBrowser, profile: settings.browserCookies.profile }, signal });
							if (yt) {
								stored.push(storeWebContent(pi, { title: yt.title, url: yt.url, content: yt.content, metadata: { tool: name, ...yt.metadata } }));
								continue;
							}
						}
						if (isProbablyPdf(url)) {
							const response = await fetch(url, { signal });
							if (!response.ok) throw new Error(`PDF fetch failed (${response.status}) for ${url}`);
							const buffer = await response.arrayBuffer();
							await handlePdfBuffer(buffer, { provider: "http", url, title: url.split("/").pop() || url });
							continue;
						}
						const extracted = await fetchHttpContent(url, { signal, jinaFallback: settings.htmlExtraction.jinaFallback, jinaApiKey: settings.apiKeys.jina });
						stored.push(storeWebContent(pi, { title: extracted.title, url: extracted.url, content: extracted.content, metadata: { provider: "http", tool: name, ...extracted.metadata } }));
					} catch (error) {
						failed.push({ url, error });
					}
				}
				if (failed.length) {
					const localFailure = failed.find((item) => isLocalFileInput(item.url));
					if (localFailure) throw new Error(`Local file extraction failed for ${localFailure.url}: ${localFailure.error instanceof Error ? localFailure.error.message : String(localFailure.error)}`);
					if (params.provider === "http" || !settings.apiKeys.exa) throw new Error(`Direct fetch failed for ${failed.map((item) => item.url).join(", ")}: ${failed[0]?.error instanceof Error ? failed[0].error.message : String(failed[0]?.error)}`);
					stored.push(...await fetchWithExa(failed.map((item) => item.url)));
				}
				const actualProvider = storedProvider(stored);
				return buildWebFetchToolResult(stored, params.provider === "http" ? "http" : actualProvider, previewLimit(params), pageImages);
			}
			const stored = await fetchWithExa(list);
			return buildWebFetchToolResult(stored, "exa", previewLimit(params));
		},
	};
}
