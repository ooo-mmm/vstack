/**
 * Claude-style status line + single-line prompt for pi.
 *
 * Auto-loaded from ~/.pi/agent/extensions/statusline/index.ts.
 */

import { CustomEditor, type ExtensionAPI, type ExtensionContext, type KeybindingsManager, type Theme } from "@mariozechner/pi-coding-agent";
import type { EditorTheme, TUI } from "@mariozechner/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const DIM = "\x1b[38;5;8m";
const RESET = "\x1b[0m";
const DEFAULT_INPUT_BOTTOM_PADDING_LINES = 0;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".heic", ".heif"]);
const IMAGE_PATH_PATTERN = /(^|[\s(\[{<"'`])(@?(?:~|\.\.?|\/)[^\s)\]}>"'`]+?\.(?:png|jpe?g|gif|webp|bmp|tiff?|heic|heif))(?=$|[\s)\]}>"'`,.;:!?])/gi;
const IMAGE_ALIAS_SYMBOL = Symbol.for("vstack.pi-qol.image-path-aliases");
const INSTALL_SYMBOL = Symbol.for("vstack.pi-statusline.installed");
const QOL_STATUS_KEY = "qol-attachments";

interface GitState {
	projectName: string;
	branch?: string;
	dirty: boolean;
	inLinkedWorktree: boolean;
}

interface ImageAliasState {
	next: number;
	byLabel: Record<string, string>;
	byPath: Record<string, string>;
}

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

function readExtensionConfig(extensionId: string, cwd?: string): VstackConfig {
	const merged: VstackConfig = {};
	for (const path of piSettingsPaths(cwd)) {
		if (!existsSync(path)) continue;
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			const config = parsed?.vstack?.extensionManager?.config?.[extensionId];
			if (config && typeof config === "object" && !Array.isArray(config)) Object.assign(merged, config);
		} catch {
			// Ignore malformed optional manager config.
		}
	}
	return merged;
}

function readVstackConfig(cwd?: string): VstackConfig {
	return readExtensionConfig("pi-statusline", cwd);
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

function qolSettingBoolean(key: string, fallback: boolean, cwd?: string): boolean {
	const value = readExtensionConfig("pi-qol", cwd)[key];
	return typeof value === "boolean" ? value : fallback;
}

function qolSettingString(key: string, fallback: string, cwd?: string): string {
	const value = readExtensionConfig("pi-qol", cwd)[key];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function basename(input: string): string {
	return input.replace(/\/$/, "").split("/").filter(Boolean).pop() ?? input;
}

function repoNameFromRemote(remote: string): string | undefined {
	const trimmed = remote.trim().replace(/\.git$/, "");
	const match = trimmed.match(/([^/:]+)$/);
	return match?.[1];
}

function formatModel(ctx: ExtensionContext, pi: ExtensionAPI): string {
	const model = ctx.model;
	if (!model) return `no model / ${pi.getThinkingLevel()}`;

	let name = model.name || model.id;
	name = name.replace(/^Claude\s+/i, "");
	name = name.replace(/^claude[-_]/i, "");
	name = name.replace(/[-_](20\d{6}|latest)$/i, "");
	name = name.replace(/^gpt[-_]/i, "GPT ");
	name = name.replace(/[-_]/g, " ");
	name = name.replace(/\bopus\b/i, "Opus");
	name = name.replace(/\bsonnet\b/i, "Sonnet");
	name = name.replace(/\bhaiku\b/i, "Haiku");
	name = name.replace(/\s+/g, " ").trim();

	// Humanize common Claude ids like opus 4 5 -> Opus 4.5.
	name = name.replace(/\b(Opus|Sonnet|Haiku) (\d) (\d)\b/, "$1 $2.$3");
	return `${name} / ${pi.getThinkingLevel()}`;
}

function formatWindow(tokens: number | undefined): string {
	if (!tokens || tokens <= 0) return "?";
	if (tokens >= 1_000_000) {
		const value = tokens / 1_000_000;
		return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}M`;
	}
	if (tokens >= 1_000) {
		const value = tokens / 1_000;
		return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}k`;
	}
	return `${tokens}`;
}

function contextInfo(ctx: ExtensionContext): { label: string; percent: number | null } {
	const usage = ctx.getContextUsage();
	const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	if (typeof usage?.percent !== "number") {
		return { label: formatWindow(contextWindow), percent: null };
	}

	const usedPercent = Math.max(0, Math.min(100, Math.round(usage.percent)));
	return { label: formatWindow(contextWindow), percent: 100 - usedPercent };
}

function gitBadge(state: GitState, showDirtyMarker: boolean): string {
	if (!state.branch) return "";
	const icon = state.inLinkedWorktree || state.branch !== "main" ? `🌳 ${state.branch}` : "🦀";
	return ` (${icon}${state.dirty && showDirtyMarker ? "*" : ""})`;
}

interface VisibleMap {
	text: string;
	rawIndexByVisibleIndex: number[];
}

interface VisibleReplacement {
	start: number;
	end: number;
	text: string;
}

function ansiSequenceEnd(input: string, start: number): number {
	const introducer = input[start + 1];
	if (introducer == null) return start + 1;

	// OSC, DCS, APC, PM, SOS strings are zero-width and end in ST (ESC \\).
	// OSC may also end in BEL.
	if (introducer === "]" || introducer === "P" || introducer === "_" || introducer === "^" || introducer === "X") {
		const st = input.indexOf("\x1b\\", start + 2);
		const bell = introducer === "]" ? input.indexOf("\x07", start + 2) : -1;
		if (bell >= 0 && (st < 0 || bell < st)) return bell + 1;
		return st >= 0 ? st + 2 : input.length;
	}

	if (introducer === "[") {
		let index = start + 2;
		while (index < input.length) {
			const code = input.charCodeAt(index);
			if (code >= 0x40 && code <= 0x7e) return index + 1;
			index += 1;
		}
		return input.length;
	}

	return Math.min(start + 2, input.length);
}

function buildVisibleMap(input: string): VisibleMap {
	const rawIndexByVisibleIndex: number[] = [0];
	let text = "";
	let index = 0;

	while (index < input.length) {
		if (input.charCodeAt(index) === 0x1b) {
			index = ansiSequenceEnd(input, index);
			continue;
		}

		if (rawIndexByVisibleIndex[text.length] === undefined) rawIndexByVisibleIndex[text.length] = index;
		text += input[index] ?? "";
		index += 1;
		rawIndexByVisibleIndex[text.length] = index;
	}

	if (rawIndexByVisibleIndex[text.length] === undefined) rawIndexByVisibleIndex[text.length] = index;
	return { rawIndexByVisibleIndex, text };
}

function stripAnsi(text: string): string {
	return buildVisibleMap(text).text;
}

function applyVisibleReplacements(input: string, map: VisibleMap, replacements: VisibleReplacement[]): string {
	if (replacements.length === 0) return input;

	const sorted = replacements
		.filter((replacement) => replacement.end > replacement.start)
		.sort((a, b) => a.start - b.start || b.end - a.end);

	let output = "";
	let lastRawIndex = 0;
	let lastVisibleIndex = 0;

	for (const replacement of sorted) {
		if (replacement.start < lastVisibleIndex) continue;
		const rawStart = map.rawIndexByVisibleIndex[replacement.start];
		const rawEnd = map.rawIndexByVisibleIndex[replacement.end];
		if (rawStart == null || rawEnd == null || rawStart < lastRawIndex) continue;

		output += input.slice(lastRawIndex, rawStart) + replacement.text;
		lastRawIndex = rawEnd;
		lastVisibleIndex = replacement.end;
	}

	return output + input.slice(lastRawIndex);
}

function stripAtPrefix(path: string): string {
	return path.startsWith("@") ? path.slice(1) : path;
}

function resolveMaybeImagePath(path: string, cwd: string): string | undefined {
	const clean = stripAtPrefix(path);
	const expanded = expandHome(clean);
	const resolved = expanded.startsWith("/") ? expanded : resolve(cwd, expanded);
	const lower = resolved.toLowerCase();
	const dot = lower.lastIndexOf(".");
	if (dot < 0 || !IMAGE_EXTENSIONS.has(lower.slice(dot))) return undefined;
	if (!existsSync(resolved)) return undefined;
	return resolved;
}

function imagePathLabels(text: string, cwd: string): string[] {
	const seen = new Set<string>();
	for (const match of text.matchAll(IMAGE_PATH_PATTERN)) {
		const resolved = resolveMaybeImagePath(match[2] ?? "", cwd);
		if (resolved) seen.add(`Image ${basename(resolved)}`);
	}
	return [...seen].sort();
}

function aliasState(): ImageAliasState {
	const host = globalThis as unknown as Record<PropertyKey, unknown>;
	const existing = host[IMAGE_ALIAS_SYMBOL] as ImageAliasState | undefined;
	if (existing?.byLabel && existing.byPath) return existing;
	const created: ImageAliasState = { byLabel: {}, byPath: {}, next: 1 };
	host[IMAGE_ALIAS_SYMBOL] = created;
	return created;
}

function aliasForImagePath(path: string): string {
	const state = aliasState();
	const existing = state.byPath[path];
	if (existing) return existing;
	const label = `[Image #${state.next++}]`;
	state.byPath[path] = label;
	state.byLabel[label] = path;
	return label;
}

function collapseImagePathsInText(text: string, cwd: string): string {
	return text.replace(IMAGE_PATH_PATTERN, (match, prefix: string, rawPath: string) => {
		const resolved = resolveMaybeImagePath(rawPath, cwd);
		if (!resolved) return match;
		return `${prefix}${aliasForImagePath(resolved)}`;
	});
}

function attachmentLabels(text: string, cwd = process.cwd()): string[] {
	const seen = new Set<string>();
	for (const match of text.matchAll(/\[Image\s+#(\d+)\]/gi)) seen.add(`Image #${match[1]}`);
	for (const label of imagePathLabels(text, cwd)) seen.add(label);
	return [...seen].sort((a, b) => Number(a.replace(/\D/g, "")) - Number(b.replace(/\D/g, "")) || a.localeCompare(b));
}

function chip(label: string, theme?: Theme): string {
	const text = ` ${label} `;
	if (theme) return theme.fg("accent", theme.inverse(text));
	return `\x1b[7m${text}${RESET}`;
}

function imageChipReplacements(visibleText: string, cwd: string, theme?: Theme): VisibleReplacement[] {
	const replacements: VisibleReplacement[] = [];

	for (const match of visibleText.matchAll(/\[Image\s+#(\d+)\]/gi)) {
		const start = match.index ?? 0;
		replacements.push({
			start,
			end: start + match[0].length,
			text: chip(`Image #${match[1]}`, theme),
		});
	}

	let imageIndex = 0;
	for (const match of visibleText.matchAll(IMAGE_PATH_PATTERN)) {
		const prefix = match[1] ?? "";
		const rawPath = match[2] ?? "";
		const resolved = resolveMaybeImagePath(rawPath, cwd);
		if (!resolved) continue;

		imageIndex += 1;
		const start = (match.index ?? 0) + prefix.length;
		replacements.push({
			start,
			end: start + rawPath.length,
			text: chip(`Image ${imageIndex}`, theme),
		});
	}

	return replacements;
}

function styleImageChips(line: string, cwd: string, theme?: Theme): string {
	if (!qolSettingBoolean("showImageChips", true, cwd)) return line;
	const map = buildVisibleMap(line);
	const replacements = imageChipReplacements(map.text, cwd, theme);
	return replacements.length === 0 ? line : applyVisibleReplacements(line, map, replacements);
}

function isEditorBorderLine(line: string): boolean {
	const visible = stripAnsi(line).trim();
	return visible.length > 0 && /^[─━╭╮╰╯┌┐└┘]+$/.test(visible);
}

function makeFallbackGitState(cwd: string): GitState {
	return {
		projectName: basename(cwd),
		dirty: false,
		inLinkedWorktree: false,
	};
}

async function runGit(pi: ExtensionAPI, cwd: string, args: string[]): Promise<string | undefined> {
	try {
		const result = await pi.exec("git", ["-C", cwd, ...args], { timeout: settingNumber("gitRefreshTimeoutMs", 1500, cwd) });
		if (result.code !== 0) return undefined;
		const stdout = result.stdout.trim();
		return stdout.length > 0 ? stdout : undefined;
	} catch {
		return undefined;
	}
}

async function refreshGitState(pi: ExtensionAPI, ctx: ExtensionContext): Promise<GitState> {
	const cwd = ctx.cwd;
	const topLevel = await runGit(pi, cwd, ["rev-parse", "--show-toplevel"]);
	if (!topLevel) return makeFallbackGitState(cwd);

	const [remote, worktreesRaw, branchRaw, shortHead, diffExit] = await Promise.all([
		runGit(pi, cwd, ["remote", "get-url", "origin"]),
		runGit(pi, cwd, ["worktree", "list", "--porcelain"]),
		runGit(pi, cwd, ["branch", "--show-current"]),
		runGit(pi, cwd, ["rev-parse", "--short", "HEAD"]),
		pi.exec("git", ["-C", cwd, "diff-index", "--quiet", "HEAD", "--"], { timeout: settingNumber("gitRefreshTimeoutMs", 1500, cwd) })
			.then((result) => result.code)
			.catch(() => 0),
	]);

	const firstWorktreeLine = worktreesRaw?.split("\n").find((line) => line.startsWith("worktree "));
	const mainWorktree = firstWorktreeLine?.slice("worktree ".length).trim();
	const inLinkedWorktree = Boolean(mainWorktree && mainWorktree !== topLevel);
	const projectName = repoNameFromRemote(remote ?? "") ?? basename(mainWorktree || topLevel);
	const branch = branchRaw || shortHead;

	return {
		projectName,
		branch,
		dirty: diffExit === 1,
		inLinkedWorktree,
	};
}

function renderStatusLine(
	width: number,
	ctx: ExtensionContext,
	git: GitState,
	pi: ExtensionAPI,
	theme: { fg: (color: string, text: string) => string },
): string {
	const { label: contextLabel, percent } = contextInfo(ctx);
	const leftPlain = `${git.projectName}${gitBadge(git, settingBoolean("showDirtyMarker", true, ctx.cwd))} ${formatModel(ctx, pi)} (${contextLabel})`;
	const rightPlain = percent === null ? "…%" : `${percent}%`;
	const percentColor = percent === null ? "muted" : percent <= 15 ? "error" : percent <= 30 ? "warning" : "success";

	const left = theme.fg("accent", leftPlain);
	const right = theme.fg(percentColor, rightPlain);
	const minimumGap = 1;
	const gapWidth = Math.max(minimumGap, width - visibleWidth(leftPlain) - visibleWidth(rightPlain) - 2);
	const filled = percent === null ? 0 : Math.round(gapWidth * (percent / 100));
	const empty = Math.max(0, gapWidth - filled);
	const bar = " ".repeat(empty) + theme.fg("warning", "─".repeat(filled));

	return truncateToWidth(`${left} ${bar} ${right}`, width, "");
}

class ClaudePromptEditor extends CustomEditor {
	constructor(
		tui: TUI,
		editorTheme: EditorTheme,
		keybindings: KeybindingsManager,
		private readonly inputBottomPaddingLines: number,
		private readonly ctx: ExtensionContext,
	) {
		super(tui, editorTheme, keybindings, { paddingX: 0 });
	}

	handleInput(data: string): void {
		const fallback = qolSettingString("newlineFallbackKey", "ctrl+j", this.ctx.cwd);
		const newlineEnabled = qolSettingBoolean("newlineOnShiftEnter", true, this.ctx.cwd);
		const isShiftEnter = matchesKey(data, "shift+enter") || matchesKey(data, "shift+return");
		const isFallback = fallback !== "none" && matchesKey(data, fallback);
		if (newlineEnabled && (isShiftEnter || isFallback)) {
			super.handleInput("\n");
			this.collapseImagePaths();
			this.refreshQolStatus();
			return;
		}
		super.handleInput(data);
		this.collapseImagePaths();
		this.refreshQolStatus();
	}

	render(width: number): string[] {
		const prompt = this.borderColor("π");
		const prefix = `${prompt} `;
		const prefixWidth = visibleWidth("π ");
		const continuationPrefix = " ".repeat(prefixWidth);
		const innerWidth = Math.max(1, width - prefixWidth);
		const rendered = super.render(innerWidth);

		// CustomEditor renders hidden border rows around the editable content. The
		// bottom border moves down as the editor wraps; keeping a fixed rendered[1]
		// dropped the second visual line and made the border appear only later.
		const inputLines: string[] = [];
		let completionLines: string[] = [];
		for (let index = 1; index < rendered.length; index++) {
			const line = rendered[index] ?? "";
			if (isEditorBorderLine(line)) {
				completionLines = rendered.slice(index + 1);
				break;
			}
			inputLines.push(line);
		}

		const lines = (inputLines.length > 0 ? inputLines : [""]).map((line, index) => {
			const linePrefix = index === 0 ? prefix : continuationPrefix;
			const content = styleImageChips(line, this.ctx.cwd, this.ctx.ui.theme);
			return truncateToWidth(linePrefix + content, width, "");
		});
		for (let index = 0; index < this.inputBottomPaddingLines; index++) {
			lines.push("");
		}

		// Keep autocomplete visible below the wrapped prompt.
		for (const line of completionLines) {
			lines.push(truncateToWidth(`${DIM}${continuationPrefix}${RESET}${line}`, width, ""));
		}
		return lines;
	}

	private collapseImagePaths(): void {
		if (!qolSettingBoolean("showImageChips", true, this.ctx.cwd)) return;
		const text = this.getText();
		const collapsed = collapseImagePathsInText(text, this.ctx.cwd);
		if (collapsed !== text) this.setText(collapsed);
	}

	private refreshQolStatus(): void {
		if (!qolSettingBoolean("showAttachmentCountInStatus", true, this.ctx.cwd)) {
			this.ctx.ui.setStatus(QOL_STATUS_KEY, undefined);
			return;
		}
		const count = attachmentLabels(this.getText(), this.ctx.cwd).length;
		this.ctx.ui.setStatus(QOL_STATUS_KEY, count > 0 ? `images:${count}` : undefined);
	}
}

export default function statusline(pi: ExtensionAPI) {
	const guard = pi as unknown as Record<PropertyKey, unknown>;
	if (guard[INSTALL_SYMBOL]) return;
	guard[INSTALL_SYMBOL] = true;

	let activeTui: TUI | undefined;
	let gitState: GitState | undefined;
	let refreshInFlight: Promise<void> | undefined;

	const requestRender = () => activeTui?.requestRender();

	const refresh = (ctx: ExtensionContext) => {
		if (refreshInFlight) return refreshInFlight;
		refreshInFlight = refreshGitState(pi, ctx)
			.then((next) => {
				gitState = next;
				requestRender();
			})
			.finally(() => {
				refreshInFlight = undefined;
			});
		return refreshInFlight;
	};

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI || !settingBoolean("enabled", true, ctx.cwd)) return;
		gitState = makeFallbackGitState(ctx.cwd);
		void refresh(ctx);

		if (settingBoolean("compactPrompt", true, ctx.cwd)) {
			ctx.ui.setEditorComponent((tui, theme, keybindings) => {
				activeTui = tui;
				return new ClaudePromptEditor(
					tui,
					theme,
					keybindings,
					Math.max(0, Math.floor(settingNumber("inputBottomPaddingLines", DEFAULT_INPUT_BOTTOM_PADDING_LINES, ctx.cwd))),
					ctx,
				);
			});
		}

		// Defer registration one tick so widgets registered by later-loaded
		// extensions (notably the task panel) stay above the status line.
		const statusWidgetTimer = setTimeout(() => {
			ctx.ui.setWidget("statusline", (tui, theme) => {
				activeTui = tui;
				return {
					invalidate() {},
					render(width: number): string[] {
						return [renderStatusLine(width, ctx, gitState ?? makeFallbackGitState(ctx.cwd), pi, theme)];
					},
				};
			});
		}, 0);
		statusWidgetTimer.unref?.();

		// Hide pi's built-in footer; our status line lives directly above the input.
		if (settingBoolean("replaceFooter", true, ctx.cwd)) {
			ctx.ui.setFooter((tui, _theme, footerData) => {
				activeTui = tui;
				const unsubscribe = footerData.onBranchChange(() => {
					void refresh(ctx);
					requestRender();
				});

				return {
					dispose: unsubscribe,
					invalidate() {},
					render(): string[] {
						return [];
					},
				};
			});
		}
	});

	pi.on("model_select", (_event, ctx) => {
		if (!ctx.hasUI) return;
		void refresh(ctx);
		requestRender();
	});
	pi.on("agent_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		void refresh(ctx);
		requestRender();
	});
	pi.on("message_update", (_event, ctx) => {
		if (ctx.hasUI) requestRender();
	});
	pi.on("agent_end", (_event, ctx) => {
		if (!ctx.hasUI) return;
		void refresh(ctx);
		requestRender();
	});
	pi.on("session_compact", (_event, ctx) => {
		if (!ctx.hasUI) return;
		void refresh(ctx);
		requestRender();
	});
	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setStatus(QOL_STATUS_KEY, undefined);
		ctx.ui.setWidget("statusline", undefined);
		ctx.ui.setEditorComponent(undefined);
		activeTui = undefined;
	});
}
