import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "typebox";
import { extractGitHubUrl } from "../extract/github.js";
import { fetchHttpContent, isProbablyPdf } from "../extract/http.js";
import { fetchPdfText } from "../extract/pdf.js";
import { ExaClient } from "../providers/exa.js";
import type { WebToolsSettings } from "../settings.js";
import { storeWebContent, type StoredWebContent } from "../storage.js";
import { truncateText } from "../utils/format.js";
import { accent, emptyComponent, errorSummary, firstText, muted, providerLabel, successSummary, textComponent, tree, webCallText } from "../utils/render.js";

export const webFetchSchema = Type.Object({
	url: Type.Optional(Type.String()),
	urls: Type.Optional(Type.Array(Type.String())),
	textMaxCharacters: Type.Optional(Type.Number({ description: "Preview character cap for direct/GitHub/PDF fetches and provider extraction cap for Exa fallback/override. Direct fetches still store the full extracted text in session storage before preview truncation." })),
	provider: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("http"), Type.Literal("exa")])),
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

function urls(params: WebFetchInput): string[] {
	const items = [...(params.urls ?? [])];
	if (params.url) items.unshift(params.url);
	return items.map((url) => url.trim()).filter(Boolean);
}

function fetchProviderForLabel(requested: unknown, actual?: unknown): string {
	const requestedValue = String(requested ?? "auto").trim().toLowerCase() || "auto";
	const actualValue = String(actual ?? requestedValue).trim().toLowerCase() || requestedValue;
	return actualValue;
}

function pendingFetchProviderForLabel(requested: unknown): string {
	return String(requested ?? "auto").trim().toLowerCase() === "auto" ? "resolving…" : fetchProviderForLabel(requested);
}

function storedProvider(stored: any[]): string {
	const providers = Array.from(new Set(stored.map((item) => String(item?.metadata?.provider ?? "").trim().toLowerCase()).filter(Boolean)));
	if (providers.length === 0) return "http";
	return providers.length === 1 ? providers[0]! : "mixed";
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

export function buildWebFetchToolResult(stored: StoredWebContent[], provider: string, maxCharacters = DEFAULT_WEB_FETCH_PREVIEW_CHARACTERS) {
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
		const label = item.title ?? item.url ?? "content";
		const meta = `preview ${stats.shownCharacters}/${stats.fullCharacters} chars${stats.truncated ? "; full text stored" : ""}`;
		return `- ${item.id}: ${label}\n[${meta}]\n${text}`;
	}).join("\n\n");
	const previewMeta = preview.truncated ? ` (${preview.shownCharacters}/${preview.fullCharacters} chars shown)` : "";
	return {
		content: [{ type: "text", text: `Fetched ${stored.length} URL(s). Preview returned${previewMeta}. Full extracted text is stored under content id(s): ${ids || "none"}.\n\n${previewText}\n\nUse get_web_content with the content id for stored full text.` }],
		details: { provider, stored, preview },
	};
}

export function createWebFetchToolDefinition(pi: ExtensionAPI, getSettings: (cwd?: string) => WebToolsSettings, name = "web_fetch") {
	return {
		renderShell: "self" as const,
		name,
		label: name === "web_fetch" ? "Web Fetch" : "Fetch Content",
		description: "Fetch known URL content and store full extracted text for get_web_content. Auto handles GitHub, PDF, HTML/text/JSON, with Exa contents as fallback/override. Direct/GitHub/PDF fetches store full extracted text; the tool result is only a preview.",
		promptSnippet: "Fetch and store known URL content; use the returned content id with get_web_content for full stored text.",
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
			const lines = [successSummary(theme, providerLabel(name === "web_fetch" ? "Web Fetch" : name, provider), context?.args?.url || context?.args?.urls?.[0] || "content", meta)];
			for (let index = 0; index < stored.slice(0, 3).length; index++) {
				const item = stored[index]!;
				const itemPreview = Array.isArray(preview?.items) ? preview.items.find((candidate: any) => candidate?.id === item.id) : undefined;
				const previewMeta = itemPreview?.truncated ? ` · preview ${itemPreview.shownCharacters}/${itemPreview.fullCharacters} chars` : "";
				lines.push(`${tree(theme, index === stored.length - 1 ? "└" : "├")}${accent(theme, item.title ?? item.url ?? item.id)}${muted(theme, ` · content id ${item.id}${previewMeta}`)}`);
			}
			if (stored.length > 3) lines.push(`${tree(theme, "└")}${muted(theme, `… ${stored.length - 3} more`)}`);
			return textComponent(lines.join("\n"));
		},
		async execute(_toolCallId: string, params: WebFetchInput, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
			const settings = getSettings(ctx.cwd);
			const list = urls(params);
			if (list.length === 0) throw new Error(`${name} requires url or urls.`);
			async function fetchWithExa(failedUrls: string[]) {
				const client = new ExaClient({ apiKey: settings.apiKeys.exa });
				const response = await client.contents({ urls: failedUrls, textMaxCharacters: params.textMaxCharacters }, signal);
				return response.results.map((result) => storeWebContent(pi, { title: result.title, url: result.url, content: result.text || result.summary || "", metadata: { provider: "exa", tool: name } }));
			}
			if (params.provider !== "exa") {
				const stored = [];
				const failed: Array<{ url: string; error: unknown }> = [];
				for (const url of list) {
					try {
						const github = settings.githubClone.enabled ? await extractGitHubUrl(url, { signal }).catch((error) => ({ error })) : undefined;
						if (github && !("error" in github)) {
							stored.push(storeWebContent(pi, { title: github.title, url, content: github.content, metadata: github.metadata }));
							continue;
						}
						if (isProbablyPdf(url)) {
							const pdf = await fetchPdfText(url, fetch, signal);
							stored.push(storeWebContent(pi, { title: url.split("/").pop() || url, url, content: pdf.text, metadata: { provider: "http", tool: name, ...pdf.metadata } }));
							continue;
						}
						const extracted = await fetchHttpContent(url, { signal });
						stored.push(storeWebContent(pi, { title: extracted.title, url: extracted.url, content: extracted.content, metadata: { provider: "http", tool: name, ...extracted.metadata } }));
					} catch (error) {
						failed.push({ url, error });
					}
				}
				if (failed.length) {
					if (params.provider === "http" || !settings.apiKeys.exa) throw new Error(`Direct fetch failed for ${failed.map((item) => item.url).join(", ")}: ${failed[0]?.error instanceof Error ? failed[0].error.message : String(failed[0]?.error)}`);
					stored.push(...await fetchWithExa(failed.map((item) => item.url)));
				}
				const actualProvider = storedProvider(stored);
				return buildWebFetchToolResult(stored, params.provider === "http" ? "http" : actualProvider, previewLimit(params));
			}
			const stored = await fetchWithExa(list);
			return buildWebFetchToolResult(stored, "exa", previewLimit(params));
		},
	};
}
