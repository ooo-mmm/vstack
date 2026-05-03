export const webSearchToolSchema = {
	type: "object",
	additionalProperties: false,
	properties: {},
};

export function createWebSearchToolDefinition() {
	return {
		name: "web_search",
		label: "Web Search",
		description: "OpenAI native web_search. On supported openai-codex models this package rewrites the provider payload to a native Responses web_search tool. The native provider runs the search server-side and emits a synthetic status text block summarizing the sources.",
		promptSnippet: "Search the web with OpenAI native web_search when available.",
		parameters: webSearchToolSchema,
		async execute() {
			return {
				content: [{ type: "text", text: "web_search requires native OpenAI provider handling. Use an openai-codex model with native provider handling." }],
				details: { phase: 1, nativeTool: "web_search" },
			};
		},
	};
}
