import type { AgentToolResult, ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const INSTALL_SYMBOL = Symbol.for("vstack.pi-questions.installed");
const SERVICE_SYMBOL = Symbol.for("vstack.pi-questions.service");
const POPUP_WIDTH = 96;
const POPUP_MAX_HEIGHT = "80%";
const PADDING_X = 4;
const PADDING_Y = 1;
const OPTION_ROWS = 10;

type VstackConfig = Record<string, unknown>;

type QuestionResult = QuestionAnswerResult | QuestionCancelResult;
type QuestionSource = "ui" | "bridge" | "tool" | "api" | "shutdown" | "ui_error";

interface QuestionAnswerResult {
	requestId: string;
	answers: string[][];
}

interface QuestionCancelResult {
	requestId: string;
	cancelled: true;
	error?: string;
}

interface QuestionOption {
	label: string;
	description: string;
}

interface QuestionTab {
	header: string;
	question: string;
	options: QuestionOption[];
	multiple: boolean;
}

interface QuestionRequest {
	id: string;
	header: string;
	questions: QuestionTab[];
}

interface PendingQuestionView {
	requestId: string;
	openedAt: string;
	request: QuestionRequest;
}

interface QuestionEvent {
	action: "opened" | "answered" | "rejected";
	requestId: string;
	openedAt: string;
	closedAt?: string;
	source?: QuestionSource;
	request?: QuestionRequest;
	result?: QuestionResult;
}

interface QuestionService {
	ask(ctx: ExtensionContext, payload: unknown, source?: QuestionSource): Promise<QuestionResult>;
	listPending(): PendingQuestionView[];
	reply(requestId: string, answers: unknown, source?: QuestionSource): boolean;
	reject(requestId: string, source?: QuestionSource): boolean;
	subscribe(listener: (event: QuestionEvent) => void): () => void;
	shutdown(): void;
}

interface PendingQuestion extends PendingQuestionView {
	complete(result: QuestionResult, source: QuestionSource): void;
	promise: Promise<QuestionResult>;
	requestRender?: () => void;
	uiDone?: (result: QuestionResult) => void;
}

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
			const config = parsed?.vstack?.extensionManager?.config?.["pi-questions"];
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
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

const QUESTION_TOOL_PARAMETERS = {
	type: "object",
	additionalProperties: false,
	properties: {
		id: { type: "string", description: "Stable request id. Defaults to que_<random>." },
		header: { type: "string", description: "Popup title bar text." },
		questions: {
			type: "array",
			minItems: 1,
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					header: { type: "string", description: "Tab/category title." },
					question: { type: "string", description: "Question text for this tab." },
					options: {
						type: "array",
						minItems: 1,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								label: { type: "string" },
								description: { type: "string" },
							},
							required: ["label"],
						},
					},
					multiple: { type: "boolean", default: false },
				},
				required: ["header", "question", "options"],
			},
		},
	},
	required: ["questions"],
};

function padAnsi(text: string, width: number): string {
	const truncated = truncateToWidth(text, width, "");
	return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

function popupContentWidth(width: number): number {
	return Math.max(1, width - 2 - PADDING_X * 2);
}

function framePopup(lines: string[], width: number, theme: Theme): string[] {
	if (width < 8) return lines.map((line) => truncateToWidth(line, width, ""));

	const border = (text: string) => theme.fg("borderAccent", text);
	const contentWidth = popupContentWidth(width);
	const blank = `${border("│")}${" ".repeat(width - 2)}${border("│")}`;
	const framed = [`${border("╭")}${border("─".repeat(width - 2))}${border("╮")}`];

	for (let i = 0; i < PADDING_Y; i += 1) framed.push(blank);
	for (const line of lines) {
		framed.push(`${border("│")}${" ".repeat(PADDING_X)}${padAnsi(line, contentWidth)}${" ".repeat(PADDING_X)}${border("│")}`);
	}
	for (let i = 0; i < PADDING_Y; i += 1) framed.push(blank);
	framed.push(`${border("╰")}${border("─".repeat(width - 2))}${border("╯")}`);
	return framed.map((line) => truncateToWidth(line, width, ""));
}

function selectedLine(theme: Theme, content: string, width: number): string {
	return theme.bg("toolSuccessBg", padAnsi(theme.fg("text", content), width));
}

function panelLine(content: string, width: number): string {
	return padAnsi(content, width);
}

function wrapPlain(text: string, width: number, maxLines = 3): string[] {
	const words = text.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return [""];
	const lines: string[] = [];
	let current = "";
	for (const word of words) {
		if (visibleWidth(word) > width) {
			if (current) lines.push(current);
			lines.push(truncateToWidth(word, width, ""));
			current = "";
		} else if (!current) {
			current = word;
		} else if (visibleWidth(current) + 1 + visibleWidth(word) <= width) {
			current = `${current} ${word}`;
		} else {
			lines.push(current);
			current = word;
		}
		if (lines.length >= maxLines) break;
	}
	if (current && lines.length < maxLines) lines.push(current);
	if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length) {
		lines[maxLines - 1] = truncateToWidth(`${lines[maxLines - 1]}…`, width, "");
	}
	return lines.length > 0 ? lines : [""];
}

function makeRequestId(): string {
	return `que_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
	return value as Record<string, unknown>;
}

function readString(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function normalizeRequest(payload: unknown): QuestionRequest {
	const input = asRecord(payload, "question request");
	const rawQuestions = input.questions;
	if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) throw new Error("questions must be a non-empty array");

	const questions = rawQuestions.map((rawQuestion, index) => {
		const question = asRecord(rawQuestion, `questions[${index}]`);
		const rawOptions = question.options;
		if (!Array.isArray(rawOptions) || rawOptions.length === 0) {
			throw new Error(`questions[${index}].options must be a non-empty array`);
		}

		const seen = new Set<string>();
		const options = rawOptions.map((rawOption, optionIndex) => {
			const option = asRecord(rawOption, `questions[${index}].options[${optionIndex}]`);
			const label = readString(option.label, "");
			if (!label) throw new Error(`questions[${index}].options[${optionIndex}].label is required`);
			if (seen.has(label)) throw new Error(`Duplicate option label in questions[${index}]: ${label}`);
			seen.add(label);
			return {
				description: typeof option.description === "string" ? option.description : "",
				label,
			};
		});

		return {
			header: readString(question.header, `Question ${index + 1}`),
			multiple: question.multiple === true,
			options,
			question: readString(question.question, "Choose an option."),
		};
	});

	const id = readString(input.id, makeRequestId());
	const firstHeader = questions[0]?.header ?? settingString("defaultHeader", "Question");
	return {
		header: readString(input.header ?? input.title, firstHeader),
		id,
		questions,
	};
}

function normalizeAnswers(request: QuestionRequest, rawAnswers: unknown): string[][] {
	if (!Array.isArray(rawAnswers)) throw new Error("answers must be an array of per-tab label arrays");
	if (rawAnswers.length !== request.questions.length) {
		throw new Error(`answers length (${rawAnswers.length}) must match questions length (${request.questions.length})`);
	}

	return request.questions.map((question, index) => {
		const rawTabAnswers = rawAnswers[index];
		if (!Array.isArray(rawTabAnswers)) throw new Error(`answers[${index}] must be an array`);
		const valid = new Set(question.options.map((option) => option.label));
		const unique: string[] = [];
		for (const rawLabel of rawTabAnswers) {
			if (typeof rawLabel !== "string") throw new Error(`answers[${index}] entries must be strings`);
			if (!valid.has(rawLabel)) throw new Error(`answers[${index}] contains invalid label: ${rawLabel}`);
			if (!unique.includes(rawLabel)) unique.push(rawLabel);
		}
		if (!question.multiple && unique.length > 1) {
			throw new Error(`answers[${index}] accepts only one label because multiple=false`);
		}
		return unique;
	});
}

function toPendingView(pending: PendingQuestion): PendingQuestionView {
	return {
		openedAt: pending.openedAt,
		request: pending.request,
		requestId: pending.requestId,
	};
}

class QuestionServiceImpl implements QuestionService {
	private readonly listeners = new Set<(event: QuestionEvent) => void>();
	private readonly pending = new Map<string, PendingQuestion>();

	ask(ctx: ExtensionContext, payload: unknown, source: QuestionSource = "api"): Promise<QuestionResult> {
		attachContext(ctx, this);
		const request = normalizeRequest(payload);
		if (this.pending.has(request.id)) throw new Error(`Question request already pending: ${request.id}`);

		const openedAt = new Date().toISOString();
		let resolvePromise: (result: QuestionResult) => void = () => undefined;
		const promise = new Promise<QuestionResult>((resolve) => {
			resolvePromise = resolve;
		});

		const pending: PendingQuestion = {
			complete: (result, completeSource) => {
				if (!this.pending.has(request.id)) return;
				this.pending.delete(request.id);
				const finalResult = "answers" in result ? { requestId: request.id, answers: result.answers } : { ...result, requestId: request.id };
				resolvePromise(finalResult);
				pending.uiDone?.(finalResult);
				this.publish({
					action: "answers" in finalResult ? "answered" : "rejected",
					closedAt: new Date().toISOString(),
					openedAt,
					requestId: request.id,
					result: finalResult,
					source: completeSource,
				});
			},
			openedAt,
			promise,
			request,
			requestId: request.id,
		};

		this.pending.set(request.id, pending);
		this.publish({ action: "opened", openedAt, request, requestId: request.id, source });

		if (ctx.hasUI) {
			void openQuestionPopup(ctx, pending).catch((error) => {
				pending.complete({ cancelled: true, error: stringifyError(error), requestId: request.id }, "ui_error");
			});
		}

		return promise;
	}

	listPending(): PendingQuestionView[] {
		return [...this.pending.values()].map(toPendingView);
	}

	reply(requestId: string, answers: unknown, source: QuestionSource = "bridge"): boolean {
		if (source === "bridge" && !settingBoolean("bridgeRepliesEnabled", true)) {
			throw new Error("Bridge replies are disabled by pi-questions settings");
		}
		const pending = this.pending.get(requestId);
		if (!pending) throw new Error(`No pending question request: ${requestId}`);
		pending.complete({ answers: normalizeAnswers(pending.request, answers), requestId }, source);
		return true;
	}

	reject(requestId: string, source: QuestionSource = "bridge"): boolean {
		if (source === "bridge" && !settingBoolean("bridgeRepliesEnabled", true)) {
			throw new Error("Bridge replies are disabled by pi-questions settings");
		}
		const pending = this.pending.get(requestId);
		if (!pending) throw new Error(`No pending question request: ${requestId}`);
		pending.complete({ cancelled: true, requestId }, source);
		return true;
	}

	subscribe(listener: (event: QuestionEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	shutdown(): void {
		for (const requestId of [...this.pending.keys()]) {
			this.reject(requestId, "shutdown");
		}
	}

	private publish(event: QuestionEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				// Listener failures must not break the question lifecycle.
			}
		}
	}
}

function getService(): QuestionServiceImpl {
	const host = globalThis as unknown as Record<PropertyKey, unknown>;
	const existing = host[SERVICE_SYMBOL];
	if (existing instanceof QuestionServiceImpl) return existing;
	const service = new QuestionServiceImpl();
	host[SERVICE_SYMBOL] = service;
	return service;
}

function attachContext(ctx: ExtensionContext | undefined, service: QuestionService): void {
	if (!ctx) return;
	Object.defineProperty(ctx, "askQuestions", {
		configurable: true,
		value: (payload: unknown) => service.ask(ctx, payload, "api"),
	});
}

async function openQuestionPopup(ctx: ExtensionContext, pending: PendingQuestion): Promise<void> {
	const request = pending.request;
	const optionRows = Math.max(1, Math.floor(settingNumber("optionRows", OPTION_ROWS, ctx.cwd)));
	const selections = request.questions.map(() => new Set<string>());
	const selectedRows = request.questions.map(() => 0);
	const scrollOffsets = request.questions.map(() => 0);
	let activeTab = 0;

	const clamp = () => {
		activeTab = Math.max(0, Math.min(activeTab, request.questions.length - 1));
		const optionCount = request.questions[activeTab]?.options.length ?? 0;
		selectedRows[activeTab] = Math.max(0, Math.min(selectedRows[activeTab] ?? 0, Math.max(0, optionCount - 1)));
		if (selectedRows[activeTab] < scrollOffsets[activeTab]) scrollOffsets[activeTab] = selectedRows[activeTab];
		if (selectedRows[activeTab] >= scrollOffsets[activeTab] + optionRows) {
			scrollOffsets[activeTab] = selectedRows[activeTab] - optionRows + 1;
		}
		scrollOffsets[activeTab] = Math.max(0, Math.min(scrollOffsets[activeTab], Math.max(0, optionCount - optionRows)));
	};

	const answers = () => request.questions.map((_question, index) => [...selections[index]]);
	const submit = () => pending.complete({ answers: answers(), requestId: request.id }, "ui");
	const advanceOrSubmit = () => {
		if (activeTab >= request.questions.length - 1) {
			submit();
			return;
		}
		activeTab += 1;
		clamp();
		pending.requestRender?.();
	};
	const chooseSingle = () => {
		const question = request.questions[activeTab];
		const option = question.options[selectedRows[activeTab]];
		if (!option) return;
		selections[activeTab].clear();
		selections[activeTab].add(option.label);
		advanceOrSubmit();
	};
	const toggleMulti = () => {
		const question = request.questions[activeTab];
		const option = question.options[selectedRows[activeTab]];
		if (!option) return;
		const selected = selections[activeTab];
		if (selected.has(option.label)) selected.delete(option.label);
		else selected.add(option.label);
		pending.requestRender?.();
	};

	await ctx.ui.custom<QuestionResult>(
		(tui, theme, _keybindings, done) => {
			pending.uiDone = done;
			pending.requestRender = () => tui.requestRender();

			const renderTabs = (width: number): string => {
				const parts = request.questions.map((question, index) => {
					const label = ` ${index + 1}. ${question.header} `;
					return index === activeTab
						? theme.bg("toolSuccessBg", theme.fg("text", theme.bold(label)))
						: theme.fg("muted", label);
				});
				return truncateToWidth(parts.join(" "), width, "");
			};

			const renderOption = (question: QuestionTab, option: QuestionOption, index: number, width: number): string => {
				const isCursor = index === selectedRows[activeTab];
				const isChecked = selections[activeTab].has(option.label);
				const marker = isCursor ? theme.fg("accent", "› ") : "  ";
				const checkbox = question.multiple ? (isChecked ? "☑" : "☐") : isChecked ? "●" : "○";
				const prefix = `${marker}${theme.fg(isChecked ? "accent" : "muted", checkbox)} `;
				const prefixWidth = visibleWidth("› ☐ ");
				const desc = option.description ? ` ${theme.fg(isCursor ? "text" : "dim", option.description)}` : "";
				const labelWidth = Math.max(1, width - prefixWidth - visibleWidth(desc));
				const label = truncateToWidth(option.label, labelWidth, "");
				const row = `${prefix}${isCursor ? theme.bold(label) : label}${desc}`;
				return isCursor ? selectedLine(theme, row, width) : panelLine(row, width);
			};

			const render = (width: number): string[] => {
				clamp();
				const innerWidth = popupContentWidth(width);
				const question = request.questions[activeTab];
				const lines: string[] = [];

				const title = `${theme.fg("accent", theme.bold(request.header))} ${theme.fg("muted", pending.requestId)}`;
				const esc = theme.fg("dim", "esc");
				const titleGap = Math.max(1, innerWidth - visibleWidth(`${request.header} ${pending.requestId}`) - visibleWidth("esc"));
				lines.push(panelLine(`${title}${" ".repeat(titleGap)}${esc}`, innerWidth));
				lines.push(panelLine(renderTabs(innerWidth), innerWidth));
				lines.push(panelLine("", innerWidth));
				for (const line of wrapPlain(question.question, innerWidth, 3)) {
					lines.push(panelLine(theme.fg("text", line), innerWidth));
				}
				const mode = question.multiple
					? "multi-select · space toggles · enter continues"
					: "single-select · enter picks and continues";
				lines.push(panelLine(theme.fg("dim", mode), innerWidth));
				lines.push(panelLine("", innerWidth));

				const start = scrollOffsets[activeTab];
				for (const [visibleIndex, option] of question.options.slice(start, start + optionRows).entries()) {
					lines.push(renderOption(question, option, start + visibleIndex, innerWidth));
				}
				for (let i = question.options.slice(start, start + optionRows).length; i < optionRows; i += 1) {
					lines.push(panelLine("", innerWidth));
				}

				lines.push(panelLine("", innerWidth));
				const footer = `${theme.fg("text", "enter")} ${theme.fg("dim", question.multiple ? "next/submit" : "choose")}  ${theme.fg("text", "space")} ${theme.fg("dim", question.multiple ? "toggle" : "-")}  ${theme.fg("text", "←/→")} ${theme.fg("dim", "tabs")}`;
				lines.push(panelLine(footer, innerWidth));
				return framePopup(lines, width, theme);
			};

			return {
				handleInput(data: string) {
					const question = request.questions[activeTab];
					if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
						pending.complete({ cancelled: true, requestId: request.id }, "ui");
						return;
					}
					if (matchesKey(data, "left")) {
						activeTab -= 1;
						clamp();
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "right") || matchesKey(data, "tab")) {
						activeTab += 1;
						clamp();
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "up") || data === "k") {
						selectedRows[activeTab] -= 1;
						clamp();
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "down") || data === "j") {
						selectedRows[activeTab] += 1;
						clamp();
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "pageup")) {
						selectedRows[activeTab] -= optionRows;
						clamp();
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "pagedown")) {
						selectedRows[activeTab] += optionRows;
						clamp();
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "return") || matchesKey(data, "enter")) {
						if (question.multiple) advanceOrSubmit();
						else chooseSingle();
						return;
					}
					if (data === " " && question.multiple) {
						toggleMulti();
					}
				},
				invalidate() {},
				render,
			};
		},
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				maxHeight: settingString("popupMaxHeight", POPUP_MAX_HEIGHT, ctx.cwd),
				width: Math.max(40, Math.floor(settingNumber("popupWidth", POPUP_WIDTH, ctx.cwd))),
			},
		},
	);
}

function stringifyError(error: unknown): string {
	if (error instanceof Error) return `${error.name}: ${error.message}`;
	return String(error);
}

export default function questions(pi: ExtensionAPI): void {
	const guard = pi as unknown as Record<PropertyKey, unknown>;
	if (guard[INSTALL_SYMBOL]) return;
	guard[INSTALL_SYMBOL] = true;
	if (!settingBoolean("enabled", true)) return;

	const service = getService();
	let activeCtx: ExtensionContext | undefined;

	pi.on("session_start", (_event, ctx) => {
		activeCtx = ctx;
		attachContext(ctx, service);
	});

	pi.on("session_shutdown", () => {
		service.shutdown();
	});

	pi.registerCommand("question-demo", {
		description: "Open a sample structured question popup",
		handler: async (_args, ctx) => {
			activeCtx = ctx;
			attachContext(ctx, service);
			const result = await service.ask(
				ctx,
				{
					header: "Question demo",
					questions: [
						{
							header: "Action",
							multiple: false,
							options: [
								{ description: "Proceed with the current plan.", label: "Continue" },
								{ description: "Stop and wait for operator guidance.", label: "Stop here" },
							],
							question: "How should Pi proceed?",
						},
						{
							header: "Checks",
							multiple: true,
							options: [
								{ description: "Run fast tests before continuing.", label: "Run tests" },
								{ description: "Inspect repository status.", label: "Check git status" },
							],
							question: "Which follow-up checks should be included?",
						},
					],
				},
				"api",
			);
			ctx.ui.notify(JSON.stringify(result), "info");
		},
	});

	pi.registerTool({
		name: "question",
		label: "Question",
		description: "Ask the user one or more structured multiple-choice questions. Returns selected option labels per tab.",
		parameters: QUESTION_TOOL_PARAMETERS as never,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<QuestionResult>> {
			const runCtx = ctx ?? activeCtx;
			if (!runCtx) {
				const result: QuestionCancelResult = { cancelled: true, error: "No active Pi context", requestId: "que_unavailable" };
				return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
			}
			if (!runCtx.hasUI) {
				const result: QuestionCancelResult = { cancelled: true, error: "No interactive UI available for question popup", requestId: typeof params.id === "string" ? params.id : "que_unavailable" };
				return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
			}
			activeCtx = runCtx;
			attachContext(runCtx, service);
			const result = await service.ask(runCtx, params, "tool");
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
		renderCall(args, theme) {
			let label = "pending";
			let header = "Question";
			try {
				const request = normalizeRequest(args);
				label = request.id;
				header = request.header;
			} catch {
				if (typeof args?.id === "string") label = args.id;
				if (typeof args?.header === "string") header = args.header;
			}
			return {
				invalidate() {},
				render(width: number) {
					const text = `${theme.fg("accent", theme.bold("? Question"))} ${theme.fg("muted", label)} ${header}`;
					return [truncateToWidth(text, width, "")];
				},
			};
		},
		renderResult(result, _options, theme) {
			const details = result.details as QuestionResult | undefined;
			return {
				invalidate() {},
				render(width: number) {
					const text = details && "answers" in details
						? `${theme.fg("success", "answered")} ${JSON.stringify(details.answers)}`
						: theme.fg("warning", "question cancelled");
					return [truncateToWidth(text, width, "")];
				},
			};
		},
	});
}
