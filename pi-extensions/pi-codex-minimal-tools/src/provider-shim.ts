import {
	createAssistantMessageEventStream,
	getEnvApiKey,
	registerApiProvider,
	type AssistantMessage,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import { loadSettings } from "./settings.js";
import { rewriteNativeOpenAiTools } from "./provider-native-tools.js";
import { saveBase64Image } from "./utils/images.js";
import { createHash } from "node:crypto";

const SHIM_SOURCE_ID = "vstack.pi-codex-minimal-tools";
const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const CODEX_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
const CODEX_RESPONSE_STATUSES = new Set(["completed", "incomplete", "failed", "cancelled", "queued", "in_progress"]);
let installed = false;
type ResponseStreamEvent = Record<string, any>;
type ReasoningLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

function clampReasoningLevelCompat(model: Model<"openai-codex-responses">, level: unknown): ReasoningLevel {
	if (!model.reasoning) return "off";
	if (level !== "minimal" && level !== "low" && level !== "medium" && level !== "high" && level !== "xhigh") return "off";
	if (model.thinkingLevelMap?.[level] === null) {
		const order: ReasoningLevel[] = ["high", "medium", "low", "minimal"];
		return order.find((candidate) => model.thinkingLevelMap?.[candidate] !== null) ?? "off";
	}
	return level;
}

function hasNativeMinimalTools(context: Context): boolean {
	return Boolean(context.tools?.some((tool) => tool.name === "image_generation" || tool.name === "web_search"));
}

function extractAccountId(token: string): string {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) throw new Error("Invalid token");
		const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
		const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
		if (!accountId) throw new Error("No account ID in token");
		return accountId;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		const parts = token ? token.split(".").length : 0;
		throw new Error(`Failed to extract accountId from token (${parts} JWT parts): ${detail}`);
	}
}

function resolveCodexUrl(baseUrl: string): string {
	const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_CODEX_BASE_URL;
	const normalized = raw.replace(/\/+$/, "");
	if (normalized.endsWith("/codex/responses")) return normalized;
	if (normalized.endsWith("/codex")) return `${normalized}/responses`;
	return `${normalized}/codex/responses`;
}

function sanitizeText(text: string): string {
	return text.replace(/[\uD800-\uDFFF]/g, "�");
}

function shortHash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 10);
}

function normalizeIdPart(value: unknown, fallback: string, prefix = ""): string {
	const raw = typeof value === "string" && value.length > 0 ? value : fallback;
	const normalized = raw.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^_+|_+$/g, "") || fallback;
	const withPrefix = prefix && !normalized.startsWith(prefix) ? `${prefix}${normalized}` : normalized;
	if (withPrefix.length <= 64) return withPrefix;
	const hash = shortHash(raw);
	return `${withPrefix.slice(0, Math.max(1, 64 - hash.length - 1))}_${hash}`;
}

function splitToolCallId(id: unknown): [string, string | undefined] {
	if (typeof id !== "string" || id.length === 0) return ["call_missing", undefined];
	const separator = id.lastIndexOf("|");
	if (separator === -1) return [id, undefined];
	const suffix = id.slice(separator + 1);
	// This shim encodes Responses items as "call_id|item_id". Treat the suffix
	// as an item id only when it looks like a provider item id; foreign call ids
	// may themselves contain pipes and must remain stable across tool results.
	if (!/^(?:fc|msg|item|[A-Za-z]+_)[A-Za-z0-9_-]*$/.test(suffix)) return [id, undefined];
	return [id.slice(0, separator), suffix || undefined];
}

function isSyntheticNativeWebToolCallBlock(block: unknown): boolean {
	if (!block || typeof block !== "object") return false;
	const record = block as Record<string, unknown>;
	if (record.type !== "toolCall" || record.name !== "web_search") return false;
	const args = record.arguments && typeof record.arguments === "object" ? record.arguments as Record<string, unknown> : undefined;
	return args?._vstackNativeWebStatus === true;
}

function isSyntheticNativeWebToolResult(msg: unknown): boolean {
	if (!msg || typeof msg !== "object") return false;
	const record = msg as Record<string, any>;
	if (record.role !== "toolResult") return false;
	const text = Array.isArray(record.content) ? record.content.filter((part: any) => part?.type === "text").map((part: any) => part.text).join("\n") : "";
	try {
		return JSON.parse(text)?.type === "vstack_web_search_status";
	} catch {
		return false;
	}
}

const SYNTHETIC_WEB_STATUS_ID_PREFIX = "msg_vstack_web_status";

function parseTextSignatureId(signature: unknown): string | undefined {
	if (typeof signature !== "string" || signature.length === 0) return undefined;
	if (signature.startsWith("{")) {
		try {
			const parsed = JSON.parse(signature) as { v?: number; id?: unknown };
			if (typeof parsed?.id === "string") return parsed.id;
		} catch {
			// Fall through to plain-string handling.
		}
	}
	return signature;
}

function isSyntheticNativeWebTextBlock(block: unknown): boolean {
	if (!block || typeof block !== "object") return false;
	const record = block as Record<string, unknown>;
	if (record.type !== "text") return false;
	if (record.textSignature === "vstack:native-web-search-status") return true;
	const id = parseTextSignatureId(record.textSignature);
	return Boolean(id && id.startsWith(SYNTHETIC_WEB_STATUS_ID_PREFIX));
}

function functionCallItemId(itemId: string | undefined, msgIndex: number, blockIndex: number): string {
	const fallback = `fc_${msgIndex}_${blockIndex}`;
	return normalizeIdPart(itemId?.startsWith("fc") ? itemId : fallback, fallback, "fc_");
}

function functionCallId(callId: string, msgIndex: number, blockIndex: number): string {
	return normalizeIdPart(callId, `call_${msgIndex}_${blockIndex}`, "call_");
}

function flushMissingToolResults(messages: unknown[], pendingToolCalls: Map<string, string>): void {
	for (const [callId, toolName] of pendingToolCalls) {
		messages.push({ type: "function_call_output", call_id: callId, output: sanitizeText(`No result provided for ${toolName}.`) });
	}
	pendingToolCalls.clear();
}

export function convertMessages(model: Model<"openai-codex-responses">, context: Context): unknown[] {
	const messages: unknown[] = [];
	let msgIndex = 0;
	const skippedSyntheticNativeWebCallIds = new Set<string>();
	const normalizedToolCallIds = new Map<string, string>();
	const pendingToolCalls = new Map<string, string>();
	for (const msg of context.messages) {
		if (msg.role === "user") {
			flushMissingToolResults(messages, pendingToolCalls);
			if (typeof msg.content === "string") messages.push({ role: "user", content: [{ type: "input_text", text: sanitizeText(msg.content) }] });
			else messages.push({ role: "user", content: msg.content.map((item) => item.type === "text" ? { type: "input_text", text: sanitizeText(item.text) } : { type: "input_image", detail: "auto", image_url: `data:${item.mimeType};base64,${item.data}` }) });
		} else if (msg.role === "assistant") {
			if (msg.content.every((block) => isSyntheticNativeWebToolCallBlock(block))) {
				msgIndex++;
				continue;
			}
			flushMissingToolResults(messages, pendingToolCalls);
			if (msg.stopReason === "error" || msg.stopReason === "aborted") {
				msgIndex++;
				continue;
			}
			let blockIndex = 0;
			for (const block of msg.content) {
				if (isSyntheticNativeWebTextBlock(block)) {
					blockIndex++;
					continue;
				}
				if (block.type === "text") messages.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: sanitizeText(block.text), annotations: [] }], status: "completed", id: `msg_${msgIndex}_${blockIndex}` });
				else if (block.type === "toolCall") {
					const [rawCallId, itemId] = splitToolCallId(block.id);
					if (isSyntheticNativeWebToolCallBlock(block)) {
						skippedSyntheticNativeWebCallIds.add(rawCallId);
						blockIndex++;
						continue;
					}
					const callId = functionCallId(rawCallId, msgIndex, blockIndex);
					normalizedToolCallIds.set(rawCallId, callId);
					pendingToolCalls.set(callId, block.name);
					messages.push({ type: "function_call", id: functionCallItemId(itemId, msgIndex, blockIndex), call_id: callId, name: block.name, arguments: JSON.stringify(block.arguments) });
				}
				blockIndex++;
			}
		} else if (msg.role === "toolResult") {
			if (isSyntheticNativeWebToolResult(msg)) {
				msgIndex++;
				continue;
			}
			const text = msg.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
			const [rawCallId] = splitToolCallId(msg.toolCallId);
			if (skippedSyntheticNativeWebCallIds.has(rawCallId)) {
				msgIndex++;
				continue;
			}
			const callId = normalizedToolCallIds.get(rawCallId);
			if (!callId) {
				msgIndex++;
				continue;
			}
			pendingToolCalls.delete(callId);
			messages.push({ type: "function_call_output", call_id: callId, output: sanitizeText(text || "(no output)") });
		}
		msgIndex++;
	}
	flushMissingToolResults(messages, pendingToolCalls);
	return messages;
}

function convertTools(context: Context): unknown[] | undefined {
	if (!context.tools?.length) return undefined;
	return context.tools.map((tool) => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.parameters, strict: null }));
}

function parseStreamingJson(text: string): Record<string, unknown> {
	try { return JSON.parse(text || "{}"); } catch { return {}; }
}

function encodeTextSignature(id: string): string {
	return JSON.stringify({ v: 1, id });
}

function responseMessageItemId(id: string): string {
	if (id.startsWith("msg")) return id;
	return `msg_${id.replace(/[^A-Za-z0-9_]/g, "_")}`;
}

interface StreamBlockState {
	block: any;
	contentIndex: number;
}

async function processNativeAwareResponsesStream(events: AsyncIterable<ResponseStreamEvent>, output: AssistantMessage, stream: ReturnType<typeof createAssistantMessageEventStream>): Promise<void> {
	const activeBlocks = new Map<string, StreamBlockState>();
	let lastItemId: string | undefined;
	const blockIndex = () => output.content.length - 1;
	const itemId = (item: Record<string, unknown>, fallback: string) => typeof item.id === "string" && item.id ? item.id : fallback;
	const eventItemId = (event: ResponseStreamEvent) => typeof event.item_id === "string" && event.item_id ? event.item_id : lastItemId;
	const stateForEvent = (event: ResponseStreamEvent, expectedType: string): StreamBlockState | undefined => {
		const id = eventItemId(event);
		const state = id ? activeBlocks.get(id) : undefined;
		return state?.block?.type === expectedType ? state : undefined;
	};
	const addState = (id: string, block: any, startType: "thinking_start" | "text_start" | "toolcall_start"): StreamBlockState => {
		output.content.push(block);
		const state = { block, contentIndex: blockIndex() };
		activeBlocks.set(id, state);
		lastItemId = id;
		stream.push({ type: startType, contentIndex: state.contentIndex, partial: output } as never);
		return state;
	};
	const ensureStateForDone = (item: Record<string, unknown>, expectedType: "thinking" | "text" | "toolCall"): StreamBlockState => {
		const id = itemId(item, `${expectedType}_${output.content.length}`);
		const existing = activeBlocks.get(id);
		if (existing?.block?.type === expectedType) return existing;
		if (expectedType === "thinking") return addState(id, { type: "thinking", thinking: "" }, "thinking_start");
		if (expectedType === "text") return addState(id, { type: "text", text: "" }, "text_start");
		return addState(id, { type: "toolCall", id: `${item.call_id}|${item.id}`, name: item.name, arguments: {}, partialJson: item.arguments || "" }, "toolcall_start");
	};
	for await (const event of events) {
		if (event.type === "response.created" && event.response?.id) output.responseId = event.response.id;
		else if (event.type === "response.output_item.added") {
			const item = event.item ?? {};
			const id = itemId(item, `${item.type || "item"}_${output.content.length}`);
			if (item.type === "reasoning") addState(id, { type: "thinking", thinking: "" }, "thinking_start");
			else if (item.type === "message") addState(id, { type: "text", text: "" }, "text_start");
			else if (item.type === "function_call") addState(id, { type: "toolCall", id: `${item.call_id}|${item.id}`, name: item.name, arguments: {}, partialJson: item.arguments || "" }, "toolcall_start");
		} else if (event.type === "response.reasoning_summary_text.delta") {
			const state = stateForEvent(event, "thinking");
			if (!state) continue;
			state.block.thinking += event.delta || "";
			stream.push({ type: "thinking_delta", contentIndex: state.contentIndex, delta: event.delta || "", partial: output });
		} else if (event.type === "response.output_text.delta") {
			const state = stateForEvent(event, "text");
			if (!state) continue;
			state.block.text += event.delta || "";
			stream.push({ type: "text_delta", contentIndex: state.contentIndex, delta: event.delta || "", partial: output });
		} else if (event.type === "response.function_call_arguments.delta") {
			const state = stateForEvent(event, "toolCall");
			if (!state) continue;
			state.block.partialJson += event.delta || "";
			state.block.arguments = parseStreamingJson(state.block.partialJson);
			stream.push({ type: "toolcall_delta", contentIndex: state.contentIndex, delta: event.delta || "", partial: output });
		} else if (event.type === "response.function_call_arguments.done") {
			const state = stateForEvent(event, "toolCall");
			if (!state) continue;
			state.block.partialJson = event.arguments || state.block.partialJson;
			state.block.arguments = parseStreamingJson(state.block.partialJson);
		} else if (event.type === "response.output_item.done") {
			const item = event.item ?? {};
			if (item.type === "web_search_call") continue;
			const id = itemId(item, `${item.type || "item"}_${output.content.length}`);
			if (item.type === "reasoning") {
				const state = ensureStateForDone(item, "thinking");
				state.block.thinking = item.summary?.map?.((part: any) => part.text).join("\n\n") || state.block.thinking;
				state.block.thinkingSignature = JSON.stringify(item);
				activeBlocks.delete(id);
				stream.push({ type: "thinking_end", contentIndex: state.contentIndex, content: state.block.thinking, partial: output });
			} else if (item.type === "message") {
				const state = ensureStateForDone(item, "text");
				state.block.text = item.content?.map?.((part: any) => part.type === "output_text" ? part.text : part.refusal).join("") || state.block.text;
				state.block.textSignature = encodeTextSignature(item.id || `msg_${state.contentIndex}`);
				activeBlocks.delete(id);
				stream.push({ type: "text_end", contentIndex: state.contentIndex, content: state.block.text, partial: output });
			} else if (item.type === "function_call") {
				const state = ensureStateForDone(item, "toolCall");
				const args = parseStreamingJson(state.block.partialJson || item.arguments || "{}");
				state.block.arguments = args;
				delete state.block.partialJson;
				activeBlocks.delete(id);
				stream.push({ type: "toolcall_end", contentIndex: state.contentIndex, toolCall: state.block, partial: output });
			}
		} else if (event.type === "response.completed") {
			const response = event.response ?? {};
			if (response.id) output.responseId = response.id;
			const usage = response.usage ?? {};
			const cachedTokens = usage.input_tokens_details?.cached_tokens || 0;
			output.usage = { input: (usage.input_tokens || 0) - cachedTokens, output: usage.output_tokens || 0, cacheRead: cachedTokens, cacheWrite: 0, totalTokens: usage.total_tokens || 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
			output.stopReason = response.status === "incomplete" ? "length" : output.content.some((block) => block.type === "toolCall" && !isSyntheticNativeWebToolCallBlock(block)) ? "toolUse" : "stop";
		} else if (event.type === "error") throw new Error(`Error Code ${event.code}: ${event.message}`);
	}
}

function buildHeaders(model: Model<"openai-codex-responses">, options: SimpleStreamOptions | undefined, accountId: string, token: string): Headers {
	const headers = new Headers(model.headers);
	for (const [key, value] of Object.entries(options?.headers || {})) headers.set(key, value);
	headers.set("Authorization", `Bearer ${token}`);
	headers.set("chatgpt-account-id", accountId);
	headers.set("originator", "pi");
	headers.set("User-Agent", "pi-codex-minimal-tools");
	headers.set("OpenAI-Beta", "responses=experimental");
	headers.set("accept", "text/event-stream");
	headers.set("content-type", "application/json");
	if (options?.sessionId) {
		headers.set("session_id", options.sessionId);
		headers.set("x-client-request-id", options.sessionId);
	}
	return headers;
}

const VALID_RESPONSES_ID = /^[A-Za-z0-9_-]{1,64}$/;

function sanitizeInputItemIds(input: unknown[]): unknown[] {
	return input.map((entry) => {
		if (!entry || typeof entry !== "object") return entry;
		const record = entry as Record<string, unknown>;
		const id = record.id;
		if (typeof id !== "string" || VALID_RESPONSES_ID.test(id)) return entry;
		const prefix = record.type === "function_call" ? "fc_" : record.type === "message" ? "msg_" : "item_";
		return { ...record, id: normalizeIdPart(id, `${prefix}${shortHash(id)}`, prefix) };
	});
}

function buildRequestBody(model: Model<"openai-codex-responses">, context: Context, options: SimpleStreamOptions | undefined): Record<string, unknown> {
	const messages = sanitizeInputItemIds(convertMessages(model, context));
	const body: Record<string, unknown> = {
		model: model.id,
		store: false,
		stream: true,
		instructions: context.systemPrompt,
		input: messages,
		text: { verbosity: (options as Record<string, unknown> | undefined)?.textVerbosity || "low" },
		include: ["reasoning.encrypted_content"],
		tool_choice: "auto",
		parallel_tool_calls: true,
	};
	if (options?.sessionId) body.prompt_cache_key = options.sessionId;
	if (options?.temperature !== undefined) body.temperature = options.temperature;
	if ((options as Record<string, unknown> | undefined)?.serviceTier !== undefined) body.service_tier = (options as Record<string, unknown>).serviceTier;
	const tools = convertTools(context);
	if (tools && tools.length > 0) body.tools = tools;
	if (options?.reasoning !== undefined) {
		const clamped = clampReasoningLevelCompat(model, options.reasoning);
		if (clamped !== "off") {
			const effort = model.thinkingLevelMap?.[clamped] ?? clamped;
			if (effort !== null) body.reasoning = { effort, summary: "auto" };
		}
	}
	const settings = loadSettings((context as { cwd?: string }).cwd);
	return rewriteNativeOpenAiTools(body, { webSearchExternalAccess: settings.webSearchExternalAccess }).payload as Record<string, unknown>;
}

async function* parseSSE(response: Response): AsyncGenerator<Record<string, unknown>> {
	if (!response.body) return;
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let idx = buffer.indexOf("\n\n");
			while (idx !== -1) {
				const chunk = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 2);
				const data = chunk.split("\n")
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice(5).replace(/^ /, "").replace(/\r$/, ""))
					.join("\n");
				if (data && data !== "[DONE]") {
					try { yield JSON.parse(data) as Record<string, unknown>; } catch { /* ignore malformed SSE chunks */ }
				}
				idx = buffer.indexOf("\n\n");
			}
		}
	} finally {
		try { await reader.cancel(); } catch { /* noop */ }
		try { reader.releaseLock(); } catch { /* noop */ }
	}
}

function normalizeCodexEvent(event: Record<string, unknown>): Record<string, unknown> {
	if (event.type === "response.done" || event.type === "response.completed" || event.type === "response.incomplete") {
		const response = event.response && typeof event.response === "object" ? event.response as Record<string, unknown> : undefined;
		const status = typeof response?.status === "string" && CODEX_RESPONSE_STATUSES.has(response.status) ? response.status : undefined;
		return { ...event, type: "response.completed", response: response ? { ...response, status } : response };
	}
	return event;
}

function syntheticTextEvents(text: string, id: string): ResponseStreamEvent[] {
	const messageId = responseMessageItemId(id);
	return [
		{ type: "response.output_item.added", output_index: 0, item: { id: messageId, type: "message", role: "assistant", status: "in_progress", content: [] } } as unknown as ResponseStreamEvent,
		{ type: "response.content_part.added", item_id: messageId, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } } as unknown as ResponseStreamEvent,
		{ type: "response.output_text.delta", item_id: messageId, output_index: 0, content_index: 0, delta: text } as unknown as ResponseStreamEvent,
		{ type: "response.output_item.done", output_index: 0, item: { id: messageId, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] } } as unknown as ResponseStreamEvent,
	];
}

function firstString(...values: unknown[]): string | undefined {
	for (const value of values) if (typeof value === "string" && value.length > 0) return value;
	return undefined;
}

function collectStrings(value: unknown, out = new Set<string>()): Set<string> {
	if (typeof value === "string" && value.trim()) {
		out.add(value.trim());
		return out;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectStrings(item, out);
		return out;
	}
	if (value && typeof value === "object") {
		for (const nested of Object.values(value as Record<string, unknown>)) collectStrings(nested, out);
	}
	return out;
}

function hostnameFromCandidate(value: string): string | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	try {
		const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
		if (url.hostname && url.hostname.includes(".")) return url.hostname.replace(/^www\./, "");
	} catch {
		// Ignore non-URL strings such as natural-language query text.
	}
	return undefined;
}

function webSearchActionSources(action: unknown): string[] {
	if (!action || typeof action !== "object") return [];
	const record = action as Record<string, unknown>;
	const out = new Set<string>();
	const sources = record.sources;
	if (Array.isArray(sources)) {
		for (const entry of sources) {
			if (entry && typeof entry === "object") {
				const url = (entry as Record<string, unknown>).url;
				if (typeof url === "string") {
					const host = hostnameFromCandidate(url);
					if (host) out.add(host);
				}
			} else if (typeof entry === "string") {
				const host = hostnameFromCandidate(entry);
				if (host) out.add(host);
			}
		}
	}
	if (typeof record.url === "string") {
		const host = hostnameFromCandidate(record.url);
		if (host) out.add(host);
	}
	return [...out];
}

function webSearchActionQueries(action: unknown): string[] {
	if (!action || typeof action !== "object") return [];
	const record = action as Record<string, unknown>;
	const out: string[] = [];
	if (Array.isArray(record.queries)) {
		for (const q of record.queries) if (typeof q === "string" && q.trim()) out.push(q.trim());
	}
	if (out.length === 0 && typeof record.query === "string" && record.query.trim()) out.push(record.query.trim());
	return out;
}

function webSearchSites(item: Record<string, unknown>, extra: Iterable<string> = []): string[] {
	const sites = new Set<string>(webSearchActionSources(item.action));
	for (const url of extra) {
		const host = hostnameFromCandidate(url);
		if (host) sites.add(host);
	}
	const legacyFields = [item.results, item.result, item.output, item.sources, item.citations, item.references, item.urls, item.url];
	for (const field of legacyFields) {
		for (const candidate of collectStrings(field)) {
			const site = hostnameFromCandidate(candidate);
			if (site) sites.add(site);
		}
	}
	return [...sites].sort();
}

function webSearchStatusText(query: string | undefined, sites: string[]): string {
	const header = query ? `[web_search] ${query}` : "[web_search]";
	const sourceLine = sites.length > 0 ? `\nSources: ${sites.join(", ")}` : "";
	return `${header}${sourceLine}`;
}

function imageBase64FromItem(item: Record<string, unknown>): string | undefined {
	return firstString(item.result, item.image, item.data, item.b64_json, (item.output as Record<string, unknown> | undefined)?.result, (item.output as Record<string, unknown> | undefined)?.b64_json);
}

function urlsFromAnnotation(annotation: unknown): string[] {
	if (!annotation || typeof annotation !== "object") return [];
	const record = annotation as Record<string, unknown>;
	if (record.type !== "url_citation") return [];
	return typeof record.url === "string" ? [record.url] : [];
}

function debugEventLogPath(): string | undefined {
	const env = process.env.PI_CODEX_DEBUG_EVENTS;
	if (!env || env.trim().length === 0 || env === "0" || env.toLowerCase() === "false") return undefined;
	if (env === "1" || env.toLowerCase() === "true") return "/tmp/pi-codex-events.log";
	return env;
}

function writeDebugEvent(path: string, label: string, event: Record<string, unknown>): void {
	try {
		const fs = require("node:fs") as typeof import("node:fs");
		const itemType = (event.item && typeof event.item === "object" && (event.item as Record<string, unknown>).type) || undefined;
		fs.appendFileSync(path, `${new Date().toISOString()} ${label} type=${String(event.type)} itemType=${String(itemType ?? "-")} item_id=${String(event.item_id ?? "-")}\n`);
	} catch {
		// Best-effort logging only.
	}
}

export async function* synthesizeNativeToolEvents(events: AsyncIterable<Record<string, unknown>>, cwd = process.cwd()): AsyncGenerator<ResponseStreamEvent> {
	let responseId = "response";
	let syntheticIndex = 0;
	const synthesizedWebSearchIds = new Set<string>();
	const synthesizedImageIds = new Set<string>();
	const collectedCitationUrls = new Set<string>();
	const sitesByCallId = new Map<string, Set<string>>();
	const pendingWebSearchCompletions = new Set<string>();
	const debugLogPath = debugEventLogPath();
	if (debugLogPath) {
		try {
			(require("node:fs") as typeof import("node:fs")).appendFileSync(debugLogPath, `--- session start ${new Date().toISOString()} ---\n`);
		} catch {
			// Best-effort.
		}
	}
	for await (const raw of events) {
		const event = normalizeCodexEvent(raw);
		if (debugLogPath) {
			const eventType = String(event.type ?? "");
			const itemType = (event.item && typeof event.item === "object" && (event.item as Record<string, unknown>).type) ?? "";
			if (eventType.includes("web_search") || eventType === "response.completed" || eventType === "response.created" || eventType === "response.output_text.annotation.added" || String(itemType).includes("web_search")) {
				writeDebugEvent(debugLogPath, "EVT", event);
			}
		}
		const response = event.response && typeof event.response === "object" ? event.response as Record<string, unknown> : undefined;
		if (typeof response?.id === "string") responseId = response.id;
		const item = event.item && typeof event.item === "object" ? event.item as Record<string, unknown> : undefined;
		if (event.type === "error") throw new Error(`Codex error: ${firstString(event.message, event.code) || JSON.stringify(event)}`);
		if (event.type === "response.failed") throw new Error(firstString(response?.error && typeof response.error === "object" ? (response.error as Record<string, unknown>).message : undefined) || "Codex response failed");
		if (event.type === "response.output_text.annotation.added") {
			for (const url of urlsFromAnnotation((event as Record<string, unknown>).annotation)) collectedCitationUrls.add(url);
			yield event as unknown as ResponseStreamEvent;
			continue;
		}
		if (event.type === "response.output_item.done" && item?.type === "image_generation_call") {
			const itemKey = firstString(item.id, item.call_id) ?? `image-${syntheticIndex}`;
			if (synthesizedImageIds.has(itemKey)) continue;
			synthesizedImageIds.add(itemKey);
			const base64 = imageBase64FromItem(item);
			if (base64) {
				const saved = await saveBase64Image({ base64, callId: firstString(item.id, item.call_id), cwd, format: firstString(item.output_format, item.format), responseId, settings: loadSettings(cwd) });
				for (const synthetic of syntheticTextEvents(`Generated image saved to ${saved.path}${saved.latestPath ? ` (latest: ${saved.latestPath})` : ""}.`, `vstack-image-${syntheticIndex++}`)) yield synthetic;
			} else {
				for (const synthetic of syntheticTextEvents("Image generation completed, but no base64 image payload was present in the provider event.", `vstack-image-${syntheticIndex++}`)) yield synthetic;
			}
			continue;
		}
		if (event.type === "response.output_item.done" && item?.type === "web_search_call") {
			const callId = firstString(item.id, item.call_id) ?? `vstack-web-${syntheticIndex++}`;
			pendingWebSearchCompletions.delete(callId);
			if (synthesizedWebSearchIds.has(callId)) {
				yield event as unknown as ResponseStreamEvent;
				continue;
			}
			synthesizedWebSearchIds.add(callId);
			const queries = webSearchActionQueries(item.action);
			const query = firstString(queries[0], item.query, (item.action as Record<string, unknown> | undefined)?.query);
			const initialSites = new Set(webSearchSites(item));
			sitesByCallId.set(callId, initialSites);
			const sites = [...initialSites].sort();
			for (const synthetic of syntheticTextEvents(webSearchStatusText(query, sites), `vstack-web-status-${syntheticIndex++}`)) yield synthetic;
			yield event as unknown as ResponseStreamEvent;
			continue;
		}
		if (typeof event.type === "string" && event.type.includes("web_search_call")) {
			const callId = firstString((event as Record<string, unknown>).item_id);
			if (callId) pendingWebSearchCompletions.add(callId);
			yield event as unknown as ResponseStreamEvent;
			continue;
		}
		if (event.type === "response.completed") {
			for (const callId of pendingWebSearchCompletions) {
				if (synthesizedWebSearchIds.has(callId)) continue;
				synthesizedWebSearchIds.add(callId);
				const citedHosts = new Set<string>();
				for (const url of collectedCitationUrls) {
					const host = hostnameFromCandidate(url);
					if (host) citedHosts.add(host);
				}
				sitesByCallId.set(callId, citedHosts);
				const sites = [...citedHosts].sort();
				for (const synthetic of syntheticTextEvents(webSearchStatusText(undefined, sites), `vstack-web-status-${syntheticIndex++}`)) yield synthetic;
			}
			pendingWebSearchCompletions.clear();
			const knownHosts = new Set<string>();
			for (const set of sitesByCallId.values()) for (const host of set) knownHosts.add(host);
			const newCitedHosts = new Set<string>();
			for (const url of collectedCitationUrls) {
				const host = hostnameFromCandidate(url);
				if (host && !knownHosts.has(host)) newCitedHosts.add(host);
			}
			if (newCitedHosts.size > 0) {
				const text = `Cited sources: ${[...newCitedHosts].sort().join(", ")}.`;
				for (const synthetic of syntheticTextEvents(text, `vstack-citations-${syntheticIndex++}`)) yield synthetic;
			}
			yield event as unknown as ResponseStreamEvent;
			continue;
		}
		yield event as unknown as ResponseStreamEvent;
	}
}

function emptyAssistant(model: Model<"openai-codex-responses">): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-codex-responses",
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function streamNativeAwareOpenAICodexResponses(model: Model<"openai-codex-responses">, context: Context, options?: SimpleStreamOptions) {
	const stream = createAssistantMessageEventStream();
	void (async () => {
		const output = emptyAssistant(model);
		try {
			const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
			if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);
			const body = buildRequestBody(model, context, options);
			const nextBody = await options?.onPayload?.(body, model);
			const finalBody = nextBody !== undefined ? nextBody : body;
			const response = await fetch(resolveCodexUrl(model.baseUrl), {
				method: "POST",
				headers: buildHeaders(model, options, extractAccountId(apiKey), apiKey),
				body: JSON.stringify(finalBody),
				signal: options?.signal,
			});
			const responseHeaders = Object.fromEntries(response.headers.entries());
			await options?.onResponse?.({ status: response.status, headers: responseHeaders }, model);
			if (!response.ok) {
				const errorText = await response.text();
				try {
					const parsed = JSON.parse(errorText) as { id?: string; response?: { id?: string } };
					output.responseId = parsed.response?.id ?? parsed.id ?? output.responseId;
				} catch {
					// Non-JSON error body.
				}
				throw new Error(errorText);
			}
			stream.push({ type: "start", partial: output });
			await processNativeAwareResponsesStream(synthesizeNativeToolEvents(parseSSE(response), process.cwd()), output, stream);
			stream.push({ type: "done", reason: output.stopReason === "error" || output.stopReason === "aborted" ? "stop" : output.stopReason, message: output });
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();
	return stream;
}

export function isNativeAwareCodexProviderShimInstalled(): boolean {
	return installed;
}

export function installNativeAwareCodexProviderShim(): void {
	if (installed) return;
	registerApiProvider({
		api: "openai-codex-responses",
		stream: streamNativeAwareOpenAICodexResponses as never,
		streamSimple: streamNativeAwareOpenAICodexResponses as never,
	}, SHIM_SOURCE_ID);
	installed = true;
}
