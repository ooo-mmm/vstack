import { Type, type Static } from "typebox";
import { getWebContent } from "../storage.js";
import { truncateText } from "../utils/format.js";
import { accent, emptyComponent, errorSummary, firstText, muted, providerDisplayName, providerLabel, successSummary, textComponent, tree, webCallText } from "../utils/render.js";

export const getWebContentSchema = Type.Object({
	id: Type.String({ description: "Content id returned by web_search or web_fetch." }),
	maxCharacters: Type.Optional(Type.Number()),
});
export type GetWebContentInput = Static<typeof getWebContentSchema>;

export function createGetWebContentToolDefinition(name = "get_web_content") {
	return {
		renderShell: "self" as const,
		name,
		label: "Get Web Content",
		description: "Retrieve full stored content from prior pi-web-tools calls by content id.",
		promptSnippet: "Retrieve stored full web content by id.",
		parameters: getWebContentSchema,
		renderCall(args: GetWebContentInput, theme: any, context: any) {
			if (context?.executionStarted && !context?.isPartial) return emptyComponent();
			return textComponent(webCallText(theme, providerLabel("Get Web Content", "session"), args?.id ?? "content id", args?.maxCharacters ? `${args.maxCharacters} chars` : undefined));
		},
		renderResult(result: any, options: any, theme: any, context: any) {
			if (options?.isPartial) return emptyComponent();
			if (context?.isError) {
				const message = firstText(result) || "stored content id not found";
				const lines = [errorSummary(theme, providerLabel("Get Web Content", "session"), message)];
				if (context?.args?.id) lines.push(`${tree(theme, "├")}${muted(theme, "content id ")}${accent(theme, context.args.id)}`);
				lines.push(`${tree(theme, "└")}${muted(theme, "Use the content id returned by web_search or web_fetch; URLs are not content ids.")}`);
				return textComponent(lines.join("\n"));
			}
			const details = result?.details ?? {};
			const provider = details?.metadata?.provider ?? "stored";
			const title = details.title ?? details.url ?? details.id ?? context?.args?.id ?? "content";
			const meta = [`${details.contentLength ?? 0} chars`, details.truncated ? "truncated" : undefined].filter(Boolean).join(" · ");
			const rows = [details.id ? "contentId" : undefined, provider ? "source" : undefined, details.url ? "url" : undefined].filter(Boolean);
			const lines = [successSummary(theme, providerLabel("Get Web Content", "session"), title, meta)];
			if (details.id) lines.push(`${tree(theme, rows.at(-1) === "contentId" ? "└" : "├")}${muted(theme, "content id ")}${accent(theme, details.id)}`);
			if (provider) lines.push(`${tree(theme, rows.at(-1) === "source" ? "└" : "├")}${muted(theme, "source ")}${accent(theme, providerDisplayName(provider))}`);
			if (details.url) lines.push(`${tree(theme, "└")}${muted(theme, details.url)}`);
			return textComponent(lines.join("\n"));
		},
		async execute(_toolCallId: string, params: GetWebContentInput) {
			const item = getWebContent(params.id);
			if (!item) throw new Error(`Stored content id not found: ${params.id}. Use a content id returned by web_search/web_fetch; passing a URL here will not fetch it.`);
			const { text, truncated } = truncateText(item.content, params.maxCharacters ?? 50000);
			return { content: [{ type: "text", text: `${item.title ?? item.url ?? item.id}\n${item.url ?? ""}\n\n${text}${truncated ? "\n\n[Use a larger maxCharacters value for more.]" : ""}` }], details: { ...item, truncated, maxCharacters: params.maxCharacters ?? 50000, contentLength: item.content.length } };
		},
	};
}
