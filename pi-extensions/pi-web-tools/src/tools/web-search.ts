import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "typebox";
import { ExaClient } from "../providers/exa.js";
import { nativeOpenAiNotice } from "../providers/openai-native.js";
import { PerplexityClient } from "../providers/perplexity.js";
import { resolveWebProvider } from "../provider-selection.js";
import type { WebProvider, WebToolsSettings } from "../settings.js";
import { storeWebContent } from "../storage.js";
import { sourceList } from "../utils/format.js";
import { accent, emptyComponent, errorSummary, firstText, muted, oneLine, providerLabel, successSummary, textComponent, tree, webCallText } from "../utils/render.js";

const providers = ["auto", "exa", "openai-native", "perplexity", "gemini"] as const;

export const webSearchSchema = Type.Object({
	query: Type.Optional(Type.String()),
	queries: Type.Optional(Type.Array(Type.String())),
	provider: Type.Optional(StringEnum(providers)),
	numResults: Type.Optional(Type.Number()),
	textMaxCharacters: Type.Optional(Type.Number()),
	includeDomains: Type.Optional(Type.Array(Type.String())),
	excludeDomains: Type.Optional(Type.Array(Type.String())),
	startPublishedDate: Type.Optional(Type.String()),
	endPublishedDate: Type.Optional(Type.String()),
	includeContent: Type.Optional(Type.Boolean()),
	curator: Type.Optional(Type.Boolean()),
});

export type WebSearchInput = Static<typeof webSearchSchema>;

function normalizeQueries(params: WebSearchInput): string[] {
	const queries = [...(params.queries ?? [])];
	if (params.query) queries.unshift(params.query);
	return queries.map((query) => query.trim()).filter(Boolean);
}

export function createWebSearchToolDefinition(pi: ExtensionAPI, getSettings: (cwd?: string) => WebToolsSettings, name = "web_search", forcedProvider?: WebProvider) {
	return {
		renderShell: "self" as const,
		name,
		label: "Web Search",
		description: "Unified web search. Supports provider auto|exa|openai-native|perplexity|gemini, batch queries, recency/date/domain filters, and optional content storage. Exa is the implemented direct provider; OpenAI native is rewritten before provider requests on supported models.",
		promptSnippet: "Search the web across configured providers; use provider=exa for direct results or openai-native on OpenAI/Codex models.",
		promptGuidelines: ["Use web_search for current web information; prefer web_research for deep evidence-backed findings reports."],
		parameters: webSearchSchema,
		renderCall(args: WebSearchInput, theme: any, context: any) {
			if (context?.executionStarted && !context?.isPartial) return emptyComponent();
			const query = args?.query || args?.queries?.[0] || "search";
			const batch = args?.queries && args.queries.length > 1 ? ` +${args.queries.length - 1} queries` : undefined;
			const provider = forcedProvider ?? args?.provider ?? "auto";
			return textComponent(webCallText(theme, providerLabel(name === "web_search" ? "Web Search" : name, provider), query, [batch].filter(Boolean).join(" · ")));
		},
		renderResult(result: any, options: any, theme: any, context: any) {
			if (options?.isPartial) return emptyComponent();
			if (context?.isError) return textComponent(errorSummary(theme, providerLabel(name === "web_search" ? "Web Search" : name, forcedProvider ?? context?.args?.provider ?? "auto"), firstText(result) || "failed"));
			const details = result?.details ?? {};
			const results = Array.isArray(details.results) ? details.results : [];
			const provider = details.provider ? `${details.provider}` : "provider";
			const query = context?.args?.query || context?.args?.queries?.[0] || "complete";
			const lines = [successSummary(theme, providerLabel(name === "web_search" ? "Web Search" : name, provider), query, `${results.length} results`)];
			const shown = results.slice(0, options?.expanded ? 8 : 3);
			for (let index = 0; index < shown.length; index++) {
				const item = shown[index]!;
				const title = item.title || item.url || "Untitled";
				const meta = [item.url ? oneLine(item.url, 76) : undefined].filter(Boolean).join(" · ");
				lines.push(`${tree(theme, index === shown.length - 1 && results.length <= shown.length ? "└" : "├")}${accent(theme, title)}${meta ? muted(theme, ` · ${meta}`) : ""}`);
			}
			if (results.length > (options?.expanded ? 8 : 3)) lines.push(`${tree(theme, "└")}${muted(theme, `… ${results.length - (options?.expanded ? 8 : 3)} more · Ctrl+O to expand`)}`);
			return textComponent(lines.join("\n"));
		},
		async execute(_toolCallId: string, params: WebSearchInput, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
			const settings = getSettings(ctx.cwd);
			const resolution = resolveWebProvider(forcedProvider ?? params.provider as WebProvider | undefined, settings, ctx.model as any);
			if (!resolution.provider) throw new Error(`No web_search provider available: ${resolution.reason}`);
			const queries = normalizeQueries(params);
			if (queries.length === 0) throw new Error("web_search requires query or queries.");
			if (resolution.provider === "openai-native") return { content: [{ type: "text", text: nativeOpenAiNotice() }], details: { provider: "openai-native" } };
			if (resolution.provider === "perplexity") {
				const client = new PerplexityClient({ apiKey: settings.apiKeys.perplexity });
				const all = [] as any[];
				let answer: string | undefined;
				for (const query of queries) {
					const response = await client.search({
						query,
						numResults: params.numResults,
						includeDomains: params.includeDomains,
						excludeDomains: params.excludeDomains,
						startPublishedDate: params.startPublishedDate,
						endPublishedDate: params.endPublishedDate,
					}, signal);
					if (!answer && response.answer) answer = response.answer;
					for (const result of response.results) all.push({ ...result });
				}
				const body = answer ? `${answer}\n\n${sourceList(all)}` : `Provider: perplexity\nResults: ${all.length}\n${sourceList(all)}`;
				return {
					content: [{ type: "text", text: body }],
					details: { provider: "perplexity", answer, results: all },
				};
			}
			if (resolution.provider !== "exa") throw new Error(`${resolution.provider} direct execution is staged for a follow-up; use provider=exa or openai-native.`);
			const client = new ExaClient({ apiKey: settings.apiKeys.exa });
			const all = [] as any[];
			for (const query of queries) {
				const response = await client.search({
					query,
					numResults: params.numResults,
					textMaxCharacters: params.textMaxCharacters,
					includeDomains: params.includeDomains,
					excludeDomains: params.excludeDomains,
					startPublishedDate: params.startPublishedDate,
					endPublishedDate: params.endPublishedDate,
				}, signal);
				for (const result of response.results) {
					const stored = result.text || result.summary ? storeWebContent(pi, {
						title: result.title,
						url: result.url,
						content: result.text || result.summary || "",
						metadata: { query, provider: "exa", tool: name, contentKind: "search-result", providerTextMaxCharacters: params.textMaxCharacters ?? 12000 },
					}) : undefined;
					all.push({ ...result, contentId: stored?.id });
				}
			}
			return {
				content: [{ type: "text", text: `Provider: exa\nResults: ${all.length}\n${sourceList(all)}${all.some((r) => r.contentId) ? "\n\nUse get_web_content with the content id for stored full text." : ""}` }],
				details: { provider: "exa", results: all },
			};
		},
	};
}
