import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text, truncateToWidth } from "@mariozechner/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const INSTALL_SYMBOL = Symbol.for("vstack.pi-tool-renderer.installed");
const USER_MESSAGE_PATCH_SYMBOL = Symbol.for("vstack.pi-tool-renderer.user-message-patch");
const USER_MESSAGE_BOX_STATE_SYMBOL = Symbol.for("vstack.pi-tool-renderer.user-message-box-state");

const USER_MESSAGE_BG_TOKENS = new Set(["selectedBg", "userMessageBg", "customMessageBg", "toolPendingBg", "toolSuccessBg", "toolErrorBg"]);

type VstackConfig = Record<string, unknown>;

function expandHome(input: string): string {
	if (input === "~") return homedir();
	if (input.startsWith("~/")) return join(homedir(), input.slice(2));
	return input;
}

function projectSettingsPath(cwd: string): string {
	let current = resolve(cwd);
	while (true) {
		const candidate = join(current, ".pi", "settings.json");
		if (existsSync(candidate)) return candidate;
		if (existsSync(join(current, ".pi")) || existsSync(join(current, ".git")) || existsSync(join(current, ".vstack-lock.json"))) return candidate;
		const parent = dirname(current);
		if (parent === current) return join(resolve(cwd), ".pi", "settings.json");
		current = parent;
	}
}

function piSettingsPaths(cwd = process.cwd()): string[] {
	const userDir = resolve(expandHome(process.env.PI_CODING_AGENT_DIR?.trim() || "~/.pi/agent"));
	return [join(userDir, "settings.json"), projectSettingsPath(cwd)];
}

function readVstackConfig(cwd?: string): VstackConfig {
	const merged: VstackConfig = {};
	for (const path of piSettingsPaths(cwd)) {
		if (!existsSync(path)) continue;
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			const config = parsed?.vstack?.extensionManager?.config?.["pi-tool-renderer"];
			if (config && typeof config === "object" && !Array.isArray(config)) Object.assign(merged, config);
		} catch {
			// Ignore malformed optional manager config.
		}
	}
	return merged;
}

function settingNumber(key: string, fallback: number, cwd?: string): number {
	const value = readVstackConfig(cwd)[key];
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : fallback;
}

function settingBoolean(key: string, fallback: boolean, cwd?: string): boolean {
	const value = readVstackConfig(cwd)[key];
	return typeof value === "boolean" ? value : fallback;
}

function settingString(key: string, fallback: string, cwd?: string): string {
	const value = readVstackConfig(cwd)[key];
	return typeof value === "string" ? value : fallback;
}

function userMessageBackgroundToken(cwd?: string): string {
	const token = settingString("userMessageBackground", "customMessageBg", cwd);
	return USER_MESSAGE_BG_TOKENS.has(token) ? token : "customMessageBg";
}

function lineCount(text: string): number {
	if (!text) return 0;
	return text.split(/\r?\n/).length;
}

function textContent(result: any): string {
	const part = result?.content?.find?.((candidate: any) => candidate?.type === "text" && typeof candidate.text === "string");
	return part?.text ?? "";
}

function clipLine(line: string, cwd?: string): string {
	const max = Math.max(40, Math.floor(settingNumber("maxLineWidth", 1000, cwd)));
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function preview(text: string, count: number, direction: "head" | "tail", cwd?: string): string {
	const lines = text.split(/\r?\n/);
	const selected = direction === "head" ? lines.slice(0, count) : lines.slice(-count);
	return selected.map((line) => clipLine(line, cwd)).join("\n");
}

function commandExit(text: string): number | null {
	const match = text.match(/exit code:\s*(\d+)/i) ?? text.match(/exit\s+(\d+)/i);
	return match ? Number.parseInt(match[1]!, 10) : null;
}

function diffStats(diff: string): { additions: number; removals: number } {
	let additions = 0;
	let removals = 0;
	for (const line of diff.split(/\r?\n/)) {
		if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
		if (line.startsWith("-") && !line.startsWith("---")) removals += 1;
	}
	return { additions, removals };
}

function truncatedMarker(text: string): boolean {
	return /^\s*\[(?:Output|Full output|Read output|Search output|Bash output)[^\n\]]*truncated|^\s*\[[^\n\]]*Full output saved to:/im.test(text);
}

function resultTruncated(result: any): boolean {
	const details = result?.details;
	if (typeof details?.truncation?.truncated === "boolean") return details.truncation.truncated;
	if (typeof details?.truncated === "boolean") return details.truncated;
	return truncatedMarker(textContent(result));
}

function makeText(text: string): Text {
	return new Text(text, 0, 0);
}

function makeEmpty() {
	return {
		invalidate() {},
		render(): string[] {
			return [];
		},
	};
}

interface UserMessagePatchState {
	activeCtx?: ExtensionContext;
	originalRender: (width: number) => string[];
}

function installUserMessageRenderer(pi: ExtensionAPI, UserMessageComponent: any): void {
	const prototype = UserMessageComponent?.prototype as Record<PropertyKey, unknown> | undefined;
	if (!prototype || typeof prototype.render !== "function") return;

	let state = prototype[USER_MESSAGE_PATCH_SYMBOL] as UserMessagePatchState | undefined;
	if (!state) {
		state = {
			originalRender: prototype.render as (width: number) => string[],
		};
		prototype[USER_MESSAGE_PATCH_SYMBOL] = state;
		prototype.render = function compactUserMessageRender(this: any, width: number): string[] {
			const box = this?.contentBox;
			const ctx = state?.activeCtx;
			if (box && ctx?.hasUI) {
				const cwd = ctx.cwd ?? process.cwd();
				const compact = settingBoolean("compactUserMessages", true, cwd);
				const paddingY = compact ? 0 : 1;
				const backgroundToken = compact ? userMessageBackgroundToken(cwd) : "userMessageBg";
				const boxState = `${paddingY}:${backgroundToken}`;

				if (box[USER_MESSAGE_BOX_STATE_SYMBOL] !== boxState) {
					box.paddingY = paddingY;
					box.setBgFn?.((content: string) => {
						const theme = state?.activeCtx?.ui?.theme;
						if (!theme?.bg) return content;
						try {
							return theme.bg(backgroundToken as any, content);
						} catch {
							return theme.bg("userMessageBg", content);
						}
					});
					box.invalidateCache?.();
					box[USER_MESSAGE_BOX_STATE_SYMBOL] = boxState;
				}
			}

			return state!.originalRender.call(this, width);
		};
	}

	pi.on("session_start", (_event: any, ctx: ExtensionContext) => {
		state!.activeCtx = ctx;
	});
	pi.on("session_shutdown", () => {
		if (prototype[USER_MESSAGE_PATCH_SYMBOL] === state) {
			prototype.render = state!.originalRender as unknown;
			delete prototype[USER_MESSAGE_PATCH_SYMBOL];
		}
		state!.activeCtx = undefined;
	});
}

class TruncatedLines {
	private cachedLines?: string[];
	private cachedWidth?: number;
	private readonly lines: string[];

	constructor(text: string) {
		this.lines = text ? text.split(/\r?\n/) : [];
	}

	invalidate(): void {
		this.cachedLines = undefined;
		this.cachedWidth = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const targetWidth = Math.max(1, width);
		const lines = this.lines.map((line) => truncateToWidth(line, targetWidth));
		this.cachedLines = lines;
		this.cachedWidth = width;
		return lines;
	}
}

function makeTruncatedLines(text: string): TruncatedLines {
	return new TruncatedLines(text);
}

function stackToolCalls(cwd?: string): boolean {
	return settingBoolean("stackToolCalls", false, cwd);
}

type StackChildDisplay = "rows" | "headline" | "anchor-list";

function stackChildDisplay(cwd?: string): StackChildDisplay {
	const value = readVstackConfig(cwd).stackChildDisplay;
	if (value === "rows" || value === "headline" || value === "anchor-list") return value;
	return settingBoolean("hideStackChildRows", false, cwd) ? "headline" : "rows";
}

function stackShell(cwd?: string): { renderShell?: "self" } {
	return stackToolCalls(cwd) ? { renderShell: "self" } : {};
}

function stackPrefix(theme: any): string {
	return theme.fg("muted", "● ");
}

function readCallText(args: any, theme: any): string {
	const range = args?.offset || args?.limit ? `:${args.offset ?? 1}${args.limit ? `-${Number(args.offset ?? 1) + Number(args.limit) - 1}` : ""}` : "";
	return `${theme.fg("toolTitle", theme.bold("Read "))}${theme.fg("accent", `${args?.path ?? ""}${range}`)}`;
}

function bashCallText(args: any, theme: any, cwd?: string): string {
	const max = Math.max(20, Math.floor(settingNumber("commandPreviewChars", 96, cwd)));
	const command = args?.command && args.command.length > max ? `${args.command.slice(0, max - 1)}…` : args?.command;
	return `${theme.fg("toolTitle", theme.bold("Bash $ "))}${theme.fg("accent", command ?? "")}`;
}

function readOnlyCallText(toolName: string, args: any, theme: any, cwd?: string): string {
	const query = args?.pattern ?? args?.glob ?? args?.path ?? args?.query ?? "";
	return `${theme.fg("toolTitle", theme.bold(`${toolName} `))}${theme.fg("accent", clipLine(String(query), cwd))}`;
}

type StackableToolName = "read" | "bash" | "grep" | "find" | "ls";
type StackItemStatus = "running" | "done" | "error";

interface StackItem {
	args: any;
	batchId: string;
	id: string;
	isError: boolean;
	resultText: string;
	status: StackItemStatus;
	toolName: StackableToolName;
	truncated: boolean;
}

interface StackBatch {
	anchorId: string;
	id: string;
	items: string[];
	updatedAt: number;
}

const STACKABLE_TOOLS = new Set<string>(["read", "bash", "grep", "find", "ls"]);
const stackItems = new Map<string, StackItem>();
const stackBatches = new Map<string, StackBatch>();
const stackInvalidators = new Map<string, () => void>();
let currentStackBatch: StackBatch | null = null;
let stackBatchCounter = 0;

function isStackableToolName(toolName: unknown): toolName is StackableToolName {
	return typeof toolName === "string" && STACKABLE_TOOLS.has(toolName);
}

function notifyStackBatch(batchId: string): void {
	const batch = stackBatches.get(batchId);
	if (!batch) return;
	for (const id of batch.items) stackInvalidators.get(id)?.();
}

function createStackBatch(firstId: string): StackBatch {
	const batch: StackBatch = { anchorId: firstId, id: `stack-${++stackBatchCounter}`, items: [], updatedAt: Date.now() };
	stackBatches.set(batch.id, batch);
	currentStackBatch = batch;
	return batch;
}

function ensureStackItem(toolName: StackableToolName, id: string, args: any): StackItem {
	const existing = stackItems.get(id);
	if (existing) {
		existing.args = args ?? existing.args;
		return existing;
	}
	const batch = currentStackBatch ?? createStackBatch(id);
	if (!batch.items.includes(id)) batch.items.push(id);
	const item: StackItem = { args, batchId: batch.id, id, isError: false, resultText: "", status: "running", toolName, truncated: false };
	stackItems.set(id, item);
	batch.updatedAt = Date.now();
	notifyStackBatch(batch.id);
	return item;
}

function contextToolCallId(context: any, toolName: string, args: any): string {
	return String(context?.toolCallId ?? context?.id ?? `${toolName}:${JSON.stringify(args ?? {})}`);
}

function stackItemCallText(item: StackItem, theme: any, cwd?: string): string {
	if (item.toolName === "read") return readCallText(item.args, theme);
	if (item.toolName === "bash") return bashCallText(item.args, theme, cwd);
	return readOnlyCallText(item.toolName, item.args, theme, cwd);
}

function stackItemSummary(item: StackItem, theme: any): string {
	if (item.status === "running") return theme.fg("warning", "running");
	if (item.isError) return theme.fg("error", "failed");
	if (item.toolName === "read") {
		const count = lineCount(item.resultText);
		let text = theme.fg("success", `${count} line${count === 1 ? "" : "s"}`);
		if (item.truncated) text += theme.fg("warning", " · truncated");
		return text;
	}
	if (item.toolName === "bash") {
		const exit = commandExit(item.resultText);
		const count = lineCount(item.resultText);
		const exitLabel = exit === null ? "exit 0" : `exit ${exit}`;
		let text = exit !== null && exit !== 0 ? theme.fg("error", exitLabel) : theme.fg("success", exitLabel);
		text += theme.fg("dim", ` · ${count} line${count === 1 ? "" : "s"}`);
		if (item.truncated) text += theme.fg("warning", " · truncated");
		return text;
	}
	const count = item.resultText.trim() ? lineCount(item.resultText) : 0;
	let text = theme.fg("success", `${count} result${count === 1 ? "" : "s"}`);
	if (item.truncated) text += theme.fg("warning", " · truncated");
	return text;
}

function stackItemPreview(item: StackItem, cwd?: string): string {
	if (!item.resultText || item.status === "running") return "";
	if (item.toolName === "bash") return preview(item.resultText, Math.max(1, Math.floor(settingNumber("bashPreviewLines", 80, cwd))), "tail", cwd);
	if (item.toolName === "read") return preview(item.resultText, Math.max(1, Math.floor(settingNumber("readPreviewLines", 80, cwd))), "head", cwd);
	return preview(item.resultText, Math.max(1, Math.floor(settingNumber("searchPreviewLines", 80, cwd))), "head", cwd);
}

function renderStackItemText(item: StackItem, theme: any, expanded: boolean, cwd?: string, branch = "├"): string {
	const isLast = branch === "└";
	const stem = theme.fg("muted", isLast ? "     " : "  │  ");
	let text = `${theme.fg("muted", `  ${branch} `)}${stackItemCallText(item, theme, cwd)}${theme.fg("dim", " · ")}${stackItemSummary(item, theme)}`;
	if (expanded) {
		const previewText = stackItemPreview(item, cwd);
		if (previewText) {
			const lines = previewText.split(/\r?\n/).map((line) => `${stem}${theme.fg("dim", line)}`);
			text += `\n${lines.join("\n")}`;
		}
	}
	return text;
}

function plural(count: number, singular: string, pluralText = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : pluralText}`;
}

function joinPhrases(parts: string[]): string {
	if (parts.length <= 1) return parts[0] ?? "";
	if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
	return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

function stackBatchHeadline(batch: StackBatch, theme: any, expanded: boolean, childDisplay: StackChildDisplay): string {
	const items = batch.items.map((id) => stackItems.get(id)).filter(Boolean) as StackItem[];
	const running = items.some((item) => item.status === "running");
	const done = items.filter((item) => item.status !== "running").length;
	const reads = items.filter((item) => item.toolName === "read").length;
	const shells = items.filter((item) => item.toolName === "bash").length;
	const searches = items.filter((item) => item.toolName === "grep" || item.toolName === "find" || item.toolName === "ls").length;
	const phrases: string[] = [];
	if (reads > 0) phrases.push(`${running ? "reading" : "read"} ${plural(reads, "file")}`);
	if (shells > 0) phrases.push(`${running ? "running" : "ran"} ${plural(shells, "shell command")}`);
	if (searches > 0) phrases.push(`${running ? "searching/listing" : "searched/listed"} ${plural(searches, "time")}`);
	const lead = joinPhrases(phrases) || (running ? "running tools" : "ran tools");
	const sentence = lead.charAt(0).toUpperCase() + lead.slice(1);
	const progress = running ? theme.fg("warning", ` · ${done}/${items.length} done`) : theme.fg("success", " · done");
	const expandHint = childDisplay === "headline" && !expanded && items.length > 0 ? theme.fg("dim", " · Ctrl+O to expand") : "";
	return `${stackPrefix(theme)}${sentence}${running ? "…" : ""}${progress}${expandHint}`;
}

function renderStackBatch(batch: StackBatch, theme: any, expanded: boolean, cwd?: string, childDisplay: StackChildDisplay = "rows"): TruncatedLines {
	let text = stackBatchHeadline(batch, theme, expanded, childDisplay);
	if (childDisplay === "anchor-list" || (childDisplay === "headline" && expanded)) {
		const items = batch.items.map((id) => stackItems.get(id)).filter(Boolean) as StackItem[];
		items.forEach((item, index) => {
			text += `\n${renderStackItemText(item, theme, expanded, cwd, index === items.length - 1 ? "└" : "├")}`;
		});
	}
	return makeTruncatedLines(text);
}

function renderStackedToolResult(toolName: StackableToolName, result: any, isPartial: boolean, expanded: boolean, theme: any, context: any, cwd: string) {
	const id = contextToolCallId(context, toolName, context?.args);
	const item = ensureStackItem(toolName, id, context?.args ?? {});
	if (context?.invalidate) stackInvalidators.set(id, context.invalidate);
	if (!isPartial) {
		item.status = context?.isError ? "error" : "done";
		item.isError = Boolean(context?.isError);
		item.resultText = textContent(result);
		item.truncated = resultTruncated(result);
		stackBatches.get(item.batchId)!.updatedAt = Date.now();
	}
	const batch = stackBatches.get(item.batchId);
	if (!batch) return makeEmpty();
	const effectiveCwd = context?.cwd ?? cwd;
	const childDisplay = stackChildDisplay(effectiveCwd);
	if (batch.anchorId === id) return renderStackBatch(batch, theme, expanded, effectiveCwd, childDisplay);
	if (childDisplay !== "rows") return makeEmpty();
	const items = batch.items.map((itemId) => stackItems.get(itemId)).filter(Boolean) as StackItem[];
	const index = Math.max(0, items.findIndex((candidate) => candidate.id === id));
	return makeTruncatedLines(renderStackItemText(item, theme, false, effectiveCwd, index === items.length - 1 ? "└" : "├"));
}

function registerStackEvents(pi: ExtensionAPI): void {
	pi.on("agent_start", () => {
		currentStackBatch = null;
	});
	pi.on("tool_execution_start", (event: any) => {
		if (isStackableToolName(event.toolName)) {
			ensureStackItem(event.toolName, String(event.toolCallId), event.args ?? event.input ?? {});
			return;
		}
		currentStackBatch = null;
	});
	pi.on("tool_execution_end", (event: any) => {
		const item = stackItems.get(String(event.toolCallId));
		if (!item) return;
		item.status = event.isError ? "error" : "done";
		item.isError = Boolean(event.isError);
		item.resultText = textContent(event.result);
		item.truncated = resultTruncated(event.result);
		notifyStackBatch(item.batchId);
	});
	pi.on("agent_end", () => {
		currentStackBatch = null;
	});
}

type BuiltInToolName = StackableToolName | "edit" | "write";
type BuiltInToolSet = Partial<Record<BuiltInToolName, any>>;

type BatchToolCall = { args: Record<string, any>; tool: StackableToolName };

interface BatchToolItem {
	args: Record<string, any>;
	details?: unknown;
	index: number;
	isError: boolean;
	resultText: string;
	toolName: StackableToolName;
	truncated: boolean;
}

interface BatchToolDetails {
	items: BatchToolItem[];
	failed: number;
	succeeded: number;
	total: number;
}

const builtInToolCache = new Map<string, BuiltInToolSet>();

function normalizedCwd(cwd?: string): string {
	return resolve(cwd || process.cwd());
}

function createBuiltInToolSet(agent: any, cwd: string): BuiltInToolSet {
	return {
		read: agent.createReadTool?.(cwd),
		bash: agent.createBashTool?.(cwd),
		edit: agent.createEditTool?.(cwd),
		write: agent.createWriteTool?.(cwd),
		grep: agent.createGrepTool?.(cwd),
		find: agent.createFindTool?.(cwd),
		ls: agent.createLsTool?.(cwd),
	};
}

function getBuiltInTool(agent: any, cwd: string, toolName: BuiltInToolName): any {
	const key = normalizedCwd(cwd);
	let tools = builtInToolCache.get(key);
	if (!tools) {
		tools = createBuiltInToolSet(agent, key);
		builtInToolCache.set(key, tools);
	}
	return tools[toolName];
}

function contextCwd(context: any, fallback: string): string {
	return context?.cwd ?? fallback;
}

const ToolBatchParams = {
	type: "object",
	additionalProperties: false,
	properties: {
		calls: {
			type: "array",
			minItems: 1,
			items: {
				type: "object",
				additionalProperties: true,
				description: "One tool call. Prefer { tool, args }, but flat fields such as { tool: 'read', path: 'README.md' } are also accepted.",
				properties: {
					tool: { type: "string", enum: ["read", "grep", "find", "ls", "bash"], description: "Tool to run inside the batch." },
					args: { type: "object", additionalProperties: true, description: "Arguments for the selected tool. Optional; flat sibling fields are folded into args." },
				},
				required: ["tool"],
			},
		},
		concurrency: { type: "number", description: "Maximum calls to run at once. Defaults to all calls, capped by settings." },
	},
	required: ["calls"],
} as const;

function normalizeBatchCalls(value: unknown): BatchToolCall[] {
	if (!Array.isArray(value)) return [];
	const calls: BatchToolCall[] = [];
	for (const raw of value) {
		if (!raw || typeof raw !== "object") continue;
		const tool = (raw as any).tool;
		if (!isStackableToolName(tool)) continue;
		const flatArgs: Record<string, unknown> = {};
		for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
			if (key !== "tool" && key !== "args") flatArgs[key] = val;
		}
		const nestedArgs = (raw as any).args && typeof (raw as any).args === "object" && !Array.isArray((raw as any).args) ? (raw as any).args : {};
		calls.push({ args: { ...flatArgs, ...nestedArgs }, tool });
	}
	return calls;
}

async function mapBatchWithConcurrency<TIn, TOut>(items: TIn[], concurrency: number, fn: (item: TIn, index: number) => Promise<TOut>): Promise<TOut[]> {
	const results = new Array<TOut>(items.length);
	let next = 0;
	const workers = new Array(Math.max(1, Math.min(concurrency, items.length || 1))).fill(null).map(async () => {
		while (true) {
			const index = next++;
			if (index >= items.length) return;
			results[index] = await fn(items[index], index);
		}
	});
	await Promise.all(workers);
	return results;
}

function batchStackItem(item: BatchToolItem): StackItem {
	return {
		args: item.args,
		batchId: "tool-batch",
		id: `tool-batch:${item.index}`,
		isError: item.isError,
		resultText: item.resultText,
		status: item.isError ? "error" : "done",
		toolName: item.toolName,
		truncated: item.truncated,
	};
}

function renderToolBatchText(items: BatchToolItem[], theme: any, expanded: boolean, cwd?: string): string {
	const failed = items.filter((item) => item.isError).length;
	const succeeded = items.length - failed;
	const header =
		stackPrefix(theme) +
		theme.fg("toolTitle", theme.bold(`Batch ran ${plural(items.length, "tool")}`)) +
		theme.fg(failed > 0 ? "warning" : "success", ` · ${succeeded}/${items.length} succeeded`) +
		(expanded ? "" : theme.fg("dim", " · Ctrl+O to inspect"));
	const lines = [header];
	items.forEach((item, index) => {
		const stackItem = batchStackItem(item);
		lines.push(renderStackItemText(stackItem, theme, expanded, cwd, index === items.length - 1 ? "└" : "├"));
	});
	return lines.join("\n");
}

function toolBatchOutput(items: BatchToolItem[]): string {
	const failed = items.filter((item) => item.isError).length;
	const lines = [`Batch: ${items.length - failed}/${items.length} succeeded`];
	for (const item of items) {
		const label = `${item.index + 1}. ${item.toolName}`;
		lines.push("", `## ${label}`, item.isError ? "Status: failed" : "Status: completed", item.resultText || "(no output)");
	}
	return lines.join("\n");
}

function renderToolBatchCallText(args: any, theme: any, cwd?: string): string {
	const calls = normalizeBatchCalls(args?.calls);
	const lines = [stackPrefix(theme) + theme.fg("toolTitle", theme.bold(`${calls.length || 0} batched tool${calls.length === 1 ? "" : "s"} launching`))];
	calls.slice(0, 12).forEach((call, index) => {
		const item: StackItem = { args: call.args, batchId: "call", id: String(index), isError: false, resultText: "", status: "running", toolName: call.tool, truncated: false };
		lines.push(`${theme.fg("muted", `  ${index === calls.length - 1 ? "└" : "├"} `)}${stackItemCallText(item, theme, cwd)}`);
	});
	if (calls.length > 12) lines.push(theme.fg("muted", `  └ … +${calls.length - 12} more`));
	return lines.join("\n");
}

function registerToolBatch(pi: ExtensionAPI, agent: any, cwd: string): void {
	pi.registerTool({
		renderShell: "self",
		name: "tool_batch",
		label: "Tool Batch",
		description:
			"Run multiple independent read/grep/find/ls/bash calls as one composite tool with a single stacked renderer. Prefer this over separate parallel read/search/list/diagnostic bash calls. Use bash only for diagnostic commands whose side effects and ordering do not matter.",
		promptSnippet: "Batch 2+ independent read/search/list/diagnostic bash calls into one compact result.",
		promptGuidelines: [
			"Prefer tool_batch instead of separate parallel read, grep, find, ls, or diagnostic bash calls whenever the calls are independent.",
			"Use individual read/grep/find/ls/bash calls when there is only one call, when calls depend on previous results, when bash mutates state, when streaming/live output matters, or when the user explicitly wants separate tool entries.",
			"Do not use tool_batch for edit/write or for bash commands that mutate files, depend on ordering, need streaming output, or should be inspected as separate commands.",
		],
		parameters: ToolBatchParams as never,
		async execute(toolCallId: string, params: any, signal: AbortSignal | undefined, _onUpdate: unknown, context: any) {
			const effectiveCwd = contextCwd(context, cwd);
			const calls = normalizeBatchCalls(params?.calls);
			const maxCalls = Math.max(1, Math.floor(settingNumber("batchMaxCalls", 8, effectiveCwd)));
			if (calls.length === 0) return { content: [{ type: "text", text: "No valid calls provided." }], details: { failed: 0, items: [], succeeded: 0, total: 0 } };
			if (calls.length > maxCalls) {
				return {
					content: [{ type: "text", text: `Too many calls (${calls.length}). Max is ${maxCalls}.` }],
					details: { failed: calls.length, items: [], succeeded: 0, total: calls.length },
					isError: true,
				};
			}
			const concurrency = Math.max(1, Math.min(calls.length, Math.floor(Number(params?.concurrency) || calls.length), maxCalls));
			const items = await mapBatchWithConcurrency(calls, concurrency, async (call, index): Promise<BatchToolItem> => {
				try {
					const original = getBuiltInTool(agent, effectiveCwd, call.tool);
					if (!original?.execute) throw new Error(`Built-in tool unavailable: ${call.tool}`);
					const result = await original.execute(`${toolCallId}:${index}`, call.args, signal, undefined);
					return {
						args: call.args,
						details: result?.details,
						index,
						isError: Boolean(result?.isError),
						resultText: textContent(result),
						toolName: call.tool,
						truncated: resultTruncated(result),
					};
				} catch (error) {
					return {
						args: call.args,
						index,
						isError: true,
						resultText: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
						toolName: call.tool,
						truncated: false,
					};
				}
			});
			const failed = items.filter((item) => item.isError).length;
			const details: BatchToolDetails = { failed, items, succeeded: items.length - failed, total: items.length };
			return { content: [{ type: "text", text: toolBatchOutput(items) }], details, isError: failed > 0 };
		},
		renderCall() {
			return makeEmpty();
		},
		renderResult(result: any, { expanded, isPartial }: any, theme: any, context: any) {
			if (isPartial) return makeTruncatedLines(renderToolBatchCallText(context?.args, theme, context?.cwd ?? cwd));
			const details = result.details as BatchToolDetails | undefined;
			if (!details?.items) return makeTruncatedLines(textContent(result) || "(no output)");
			return makeTruncatedLines(renderToolBatchText(details.items, theme, expanded, context?.cwd ?? cwd));
		},
	});
}

function registerRead(pi: ExtensionAPI, agent: any, cwd: string): void {
	const original = getBuiltInTool(agent, cwd, "read");
	if (!original) return;
	pi.registerTool({
		renderShell: "self",
		name: "read",
		label: "read",
		description: original.description,
		parameters: original.parameters,
		async execute(id: string, params: any, signal: AbortSignal | undefined, onUpdate: unknown, context: any) {
			return getBuiltInTool(agent, contextCwd(context, cwd), "read").execute(id, params, signal, onUpdate);
		},
		renderCall() {
			return makeEmpty();
		},
		renderResult(result: any, { expanded, isPartial }: any, theme: any, context: any) {
			const stacked = stackToolCalls(context?.cwd ?? cwd);
			if (stacked) return renderStackedToolResult("read", result, isPartial, expanded, theme, context, cwd);
			const call = readCallText(context?.args ?? {}, theme);
			if (isPartial) return makeTruncatedLines(`${stackPrefix(theme)}${call}${theme.fg("dim", " · ")}${theme.fg("warning", "reading…")}`);
			const content = textContent(result);
			const count = lineCount(content);
			let summary = theme.fg("success", `${count} line${count === 1 ? "" : "s"}`);
			if (resultTruncated(result)) summary += theme.fg("warning", " · truncated");
			let text = `${stackPrefix(theme)}${call}${theme.fg("dim", " · ")}${summary}`;
			if (expanded && content) {
				const limit = Math.max(1, Math.floor(settingNumber("readPreviewLines", 80, context?.cwd)));
				text += `\n${preview(content, limit, "head", context?.cwd)
					.split(/\r?\n/)
					.map((line) => `${theme.fg("muted", "  │ ")}${theme.fg("dim", line)}`)
					.join("\n")}`;
				if (count > limit) text += `\n${theme.fg("muted", `  │ … ${count - limit} more line(s)`)}`;
			}
			return makeTruncatedLines(text);
		},
	});
}

function registerBash(pi: ExtensionAPI, agent: any, cwd: string): void {
	const original = getBuiltInTool(agent, cwd, "bash");
	if (!original) return;
	pi.registerTool({
		renderShell: "self",
		name: "bash",
		label: "bash",
		description: original.description,
		parameters: original.parameters,
		async execute(id: string, params: any, signal: AbortSignal | undefined, onUpdate: unknown, context: any) {
			return getBuiltInTool(agent, contextCwd(context, cwd), "bash").execute(id, params, signal, onUpdate);
		},
		renderCall() {
			return makeEmpty();
		},
		renderResult(result: any, { expanded, isPartial }: any, theme: any, context: any) {
			const stacked = stackToolCalls(context?.cwd ?? cwd);
			if (stacked) return renderStackedToolResult("bash", result, isPartial, expanded, theme, context, cwd);
			const call = bashCallText(context?.args ?? {}, theme, context?.cwd ?? cwd);
			if (isPartial) return makeTruncatedLines(`${stackPrefix(theme)}${call}${theme.fg("dim", " · ")}${theme.fg("warning", "running…")}`);
			const output = textContent(result);
			const exit = commandExit(output);
			const count = lineCount(output);
			const exitLabel = exit === null ? "exit 0" : `exit ${exit}`;
			let summary = exit !== null && exit !== 0 ? theme.fg("error", exitLabel) : theme.fg("success", exitLabel);
			summary += theme.fg("dim", ` · ${count} line${count === 1 ? "" : "s"}`);
			if (resultTruncated(result)) summary += theme.fg("warning", " · truncated");
			let text = `${stackPrefix(theme)}${call}${theme.fg("dim", " · ")}${summary}`;
			if (expanded && output) {
				const limit = Math.max(1, Math.floor(settingNumber("bashPreviewLines", 80, context?.cwd)));
				text += `\n${preview(output, limit, "tail", context?.cwd)
					.split(/\r?\n/)
					.map((line) => `${theme.fg("muted", "  │ ")}${theme.fg("dim", line)}`)
					.join("\n")}`;
				if (count > limit) text += `\n${theme.fg("muted", `  │ … ${count - limit} older line(s)`)}`;
			}
			return makeTruncatedLines(text);
		},
	});
}

function registerEdit(pi: ExtensionAPI, agent: any, cwd: string): void {
	const original = getBuiltInTool(agent, cwd, "edit");
	if (!original) return;
	pi.registerTool({
		name: "edit",
		label: "edit",
		description: original.description,
		parameters: original.parameters,
		async execute(id: string, params: any, signal: AbortSignal | undefined, onUpdate: unknown, context: any) {
			return getBuiltInTool(agent, contextCwd(context, cwd), "edit").execute(id, params, signal, onUpdate);
		},
		renderCall(args: any, theme: any) {
			return makeText(`${theme.fg("toolTitle", theme.bold("Edit "))}${theme.fg("accent", args.path ?? "")}`);
		},
		renderResult(result: any, { expanded, isPartial }: any, theme: any, _context: any) {
			if (isPartial) return makeText(theme.fg("warning", "Editing…"));
			const diff = result?.details?.diff ?? "";
			const stats = diffStats(diff);
			let text = `${theme.fg("success", `+${stats.additions}`)} ${theme.fg("error", `-${stats.removals}`)}`;
			if (!diff) text = theme.fg("success", "applied");
			if (expanded && diff) text += `\n${diff}`;
			return makeText(text);
		},
	});
}

function registerWrite(pi: ExtensionAPI, agent: any, cwd: string): void {
	const original = getBuiltInTool(agent, cwd, "write");
	if (!original) return;
	pi.registerTool({
		name: "write",
		label: "write",
		description: original.description,
		parameters: original.parameters,
		async execute(id: string, params: any, signal: AbortSignal | undefined, onUpdate: unknown, context: any) {
			return getBuiltInTool(agent, contextCwd(context, cwd), "write").execute(id, params, signal, onUpdate);
		},
		renderCall(args: any, theme: any) {
			const count = lineCount(args.content ?? "");
			return makeText(`${theme.fg("toolTitle", theme.bold("Write "))}${theme.fg("accent", args.path ?? "")} ${theme.fg("dim", `· ${count} lines`)}`);
		},
		renderResult(result: any, { expanded, isPartial }: any, theme: any, context: any) {
			if (isPartial) return makeText(theme.fg("warning", "Writing…"));
			let text = theme.fg("success", "written");
			const args = context?.args ?? {};
			const content = args.content ?? textContent(result);
			if (expanded && content) {
				const limit = Math.max(1, Math.floor(settingNumber("writePreviewLines", 80, context?.cwd)));
				text += `\n${theme.fg("dim", preview(content, limit, "head", context?.cwd))}`;
				const count = lineCount(content);
				if (count > limit) text += `\n${theme.fg("muted", `… ${count - limit} more line(s)`)}`;
			}
			return makeText(text);
		},
	});
}

function registerReadOnly(pi: ExtensionAPI, agent: any, cwd: string, toolName: "grep" | "find" | "ls"): void {
	const original = getBuiltInTool(agent, cwd, toolName);
	if (!original) return;
	pi.registerTool({
		renderShell: "self",
		name: toolName,
		label: toolName,
		description: original.description,
		parameters: original.parameters,
		async execute(id: string, params: any, signal: AbortSignal | undefined, onUpdate: unknown, context: any) {
			return getBuiltInTool(agent, contextCwd(context, cwd), toolName).execute(id, params, signal, onUpdate);
		},
		renderCall() {
			return makeEmpty();
		},
		renderResult(result: any, { expanded, isPartial }: any, theme: any, context: any) {
			const stacked = stackToolCalls(context?.cwd ?? cwd);
			if (stacked) return renderStackedToolResult(toolName, result, isPartial, expanded, theme, context, cwd);
			const call = readOnlyCallText(toolName, context?.args ?? {}, theme, context?.cwd ?? cwd);
			if (isPartial) return makeTruncatedLines(`${stackPrefix(theme)}${call}${theme.fg("dim", " · ")}${theme.fg("warning", `${toolName}…`)}`);
			const output = textContent(result);
			const count = output.trim() ? lineCount(output) : 0;
			let summary = theme.fg("success", `${count} result${count === 1 ? "" : "s"}`);
			if (resultTruncated(result)) summary += theme.fg("warning", " · truncated");
			let text = `${stackPrefix(theme)}${call}${theme.fg("dim", " · ")}${summary}`;
			if (expanded && output) {
				const limit = Math.max(1, Math.floor(settingNumber("searchPreviewLines", 80, context?.cwd)));
				text += `\n${preview(output, limit, "head", context?.cwd)
					.split(/\r?\n/)
					.map((line) => `${theme.fg("muted", "  │ ")}${theme.fg("dim", line)}`)
					.join("\n")}`;
				if (count > limit) text += `\n${theme.fg("muted", `  │ … ${count - limit} more result line(s)`)}`;
			}
			return makeTruncatedLines(text);
		},
	});
}

export default async function toolRenderer(pi: ExtensionAPI): Promise<void> {
	const guard = pi as unknown as Record<PropertyKey, unknown>;
	if (guard[INSTALL_SYMBOL]) return;
	guard[INSTALL_SYMBOL] = true;
	if (!settingBoolean("enabled", true)) return;

	registerStackEvents(pi);

	const agent = await import("@mariozechner/pi-coding-agent");
	installUserMessageRenderer(pi, agent.UserMessageComponent);
	const cwd = process.cwd();
	registerRead(pi, agent, cwd);
	registerBash(pi, agent, cwd);
	if (settingBoolean("renderMutationTools", false, cwd)) {
		registerEdit(pi, agent, cwd);
		registerWrite(pi, agent, cwd);
	}
	registerReadOnly(pi, agent, cwd, "grep");
	registerReadOnly(pi, agent, cwd, "find");
	registerReadOnly(pi, agent, cwd, "ls");
	if (settingBoolean("registerBatchTool", true, cwd)) registerToolBatch(pi, agent, cwd);
}
