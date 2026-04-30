import { CustomEditor, type ExtensionAPI, type ExtensionContext, type KeybindingsManager, type Theme } from "@mariozechner/pi-coding-agent";
import type { EditorTheme, TUI } from "@mariozechner/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const INSTALL_SYMBOL = Symbol.for("vstack.pi-qol.installed");
const STATUS_KEY = "qol-attachments";
const DIM = "\x1b[38;5;8m";
const RESET = "\x1b[0m";
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".heic", ".heif"]);
const IMAGE_PATH_PATTERN = /(^|[\s(\[{<"'`])(@?(?:~|\.\.?|\/)[^\s)\]}>"'`]+?\.(?:png|jpe?g|gif|webp|bmp|tiff?|heic|heif))(?=$|[\s)\]}>"'`,.;:!?])/gi;
const IMAGE_ALIAS_SYMBOL = Symbol.for("vstack.pi-qol.image-path-aliases");

type VstackConfig = Record<string, unknown>;

interface ImageAliasState {
	next: number;
	byLabel: Record<string, string>;
	byPath: Record<string, string>;
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
			const config = parsed?.vstack?.extensionManager?.config?.["pi-qol"];
			if (config && typeof config === "object" && !Array.isArray(config)) Object.assign(merged, config);
		} catch {
			// Ignore malformed optional manager config.
		}
	}
	return merged;
}

function settingBoolean(key: string, fallback: boolean, cwd?: string): boolean {
	const value = readVstackConfig(cwd)[key];
	return typeof value === "boolean" ? value : fallback;
}

function settingString(key: string, fallback: string, cwd?: string): string {
	const value = readVstackConfig(cwd)[key];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
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

function aliasedImagePaths(text: string): string[] {
	const state = aliasState();
	const paths = new Set<string>();
	for (const match of text.matchAll(/\[Image\s+#\d+\]/gi)) {
		const path = state.byLabel[match[0]];
		if (path) paths.add(path);
	}
	return [...paths];
}

function mimeTypeForPath(path: string): string {
	const lower = path.toLowerCase();
	if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
	if (lower.endsWith(".gif")) return "image/gif";
	if (lower.endsWith(".webp")) return "image/webp";
	if (lower.endsWith(".bmp")) return "image/bmp";
	if (lower.endsWith(".tif") || lower.endsWith(".tiff")) return "image/tiff";
	if (lower.endsWith(".heic")) return "image/heic";
	if (lower.endsWith(".heif")) return "image/heif";
	return "image/png";
}

function imageContentForPath(path: string): { type: "image"; data: string; mimeType: string } | undefined {
	try {
		return { data: readFileSync(path).toString("base64"), mimeType: mimeTypeForPath(path), type: "image" };
	} catch {
		return undefined;
	}
}

function attachmentLabels(text: string, cwd = process.cwd()): string[] {
	const seen = new Set<string>();
	for (const match of text.matchAll(/\[Image\s+#(\d+)\]/gi)) {
		seen.add(`Image #${match[1]}`);
	}
	for (const label of imagePathLabels(text, cwd)) seen.add(label);
	return [...seen].sort((a, b) => Number(a.replace(/\D/g, "")) - Number(b.replace(/\D/g, "")) || a.localeCompare(b));
}

function chip(label: string, theme?: Theme): string {
	const text = ` ${label} `;
	if (theme) return theme.fg("accent", theme.inverse(text));
	return `\x1b[7m${text}${RESET}`;
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
	if (!settingBoolean("showImageChips", true, cwd)) return line;
	const map = buildVisibleMap(line);
	const replacements = imageChipReplacements(map.text, cwd, theme);
	return replacements.length === 0 ? line : applyVisibleReplacements(line, map, replacements);
}

function statusText(ctx: ExtensionContext, text: string): string | undefined {
	if (!settingBoolean("showAttachmentCountInStatus", true, ctx.cwd)) return undefined;
	const count = attachmentLabels(text, ctx.cwd).length;
	return count > 0 ? `images:${count}` : undefined;
}

class QolEditor extends CustomEditor {
	constructor(
		tui: TUI,
		editorTheme: EditorTheme,
		keybindings: KeybindingsManager,
		private readonly ctx: ExtensionContext,
	) {
		super(tui, editorTheme, keybindings);
	}

	handleInput(data: string): void {
		const fallback = settingString("newlineFallbackKey", "ctrl+j", this.ctx.cwd);
		const newlineEnabled = settingBoolean("newlineOnShiftEnter", true, this.ctx.cwd);
		const isShiftEnter = matchesKey(data, "shift+enter") || matchesKey(data, "shift+return");
		const isFallback = fallback !== "none" && matchesKey(data, fallback);
		if (newlineEnabled && (isShiftEnter || isFallback)) {
			super.handleInput("\n");
			this.collapseImagePaths();
			this.refreshAttachmentStatus();
			return;
		}
		super.handleInput(data);
		this.collapseImagePaths();
		this.refreshAttachmentStatus();
	}

	render(width: number): string[] {
		return super.render(width).map((line) => truncateToWidth(styleImageChips(line, this.ctx.cwd, this.ctx.ui.theme), width, ""));
	}

	private collapseImagePaths(): void {
		if (!settingBoolean("showImageChips", true, this.ctx.cwd)) return;
		const text = this.getText();
		const collapsed = collapseImagePathsInText(text, this.ctx.cwd);
		if (collapsed !== text) this.setText(collapsed);
	}

	private refreshAttachmentStatus(): void {
		const text = this.getText();
		this.ctx.ui.setStatus(STATUS_KEY, statusText(this.ctx, text));
	}
}

function currentEditorText(ctx: ExtensionContext): string {
	try {
		return ctx.ui.getEditorText?.() ?? "";
	} catch {
		return "";
	}
}

function collapseEditorImagePaths(ctx: ExtensionContext): boolean {
	if (!settingBoolean("showImageChips", true, ctx.cwd)) return false;
	const text = currentEditorText(ctx);
	if (!text) return false;
	const collapsed = collapseImagePathsInText(text, ctx.cwd);
	if (collapsed === text) return false;
	ctx.ui.setEditorText(collapsed);
	ctx.ui.setStatus(STATUS_KEY, statusText(ctx, collapsed));
	return true;
}

function statusMessage(ctx: ExtensionContext): string {
	const cfg = readVstackConfig(ctx.cwd);
	const labels = attachmentLabels(currentEditorText(ctx), ctx.cwd);
	return [
		"Pi QOL status",
		`Shift+Enter newline: ${settingBoolean("newlineOnShiftEnter", true, ctx.cwd) ? "enabled" : "disabled"}`,
		`Fallback newline key: ${settingString("newlineFallbackKey", "ctrl+j", ctx.cwd)}`,
		`Image chips: ${settingBoolean("showImageChips", true, ctx.cwd) ? "filled (placeholders and existing image paths)" : "off"}`,
		`Image placeholders/paths in draft: ${labels.length ? labels.join(", ") : "none"}`,
		`Hidden Thinking... placeholder setting: ${String(cfg.showHiddenThinkingPlaceholder ?? false)} (Pi API currently has no assistant-renderer hook, so this is a settings contract only.)`,
		"If Shift+Enter still submits, configure your terminal/tmux to send a distinct Shift+Enter sequence or use the fallback key.",
	].join("\n");
}

export default function qol(pi: ExtensionAPI): void {
	const guard = pi as unknown as Record<PropertyKey, unknown>;
	if (guard[INSTALL_SYMBOL]) return;
	guard[INSTALL_SYMBOL] = true;
	if (!settingBoolean("enabled", true)) return;

	let editorPollTimer: ReturnType<typeof setInterval> | undefined;
	let lastPolledDraft = "";

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setEditorComponent((tui, theme, keybindings) => new QolEditor(tui, theme, keybindings, ctx));
		if (editorPollTimer) clearInterval(editorPollTimer);
		lastPolledDraft = "";
		if (ctx.hasUI) {
			editorPollTimer = setInterval(() => {
				try {
					const draft = currentEditorText(ctx);
					if (draft === lastPolledDraft) return;
					lastPolledDraft = draft;
					if (collapseEditorImagePaths(ctx)) lastPolledDraft = currentEditorText(ctx);
				} catch {
					// Best-effort visual helper only.
				}
			}, 250);
			editorPollTimer.unref?.();
		}
		const fallback = settingString("newlineFallbackKey", "ctrl+j", ctx.cwd);
		if (ctx.hasUI && fallback !== "none") {
			ctx.ui.notify(`QOL multiline input active. Shift+Enter inserts newline when your terminal reports it; fallback: ${fallback}.`, "info");
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (editorPollTimer) clearInterval(editorPollTimer);
		editorPollTimer = undefined;
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setEditorComponent(undefined);
	});

	pi.on("input", async (event) => {
		if (event.source === "extension") return { action: "continue" };
		const paths = aliasedImagePaths(event.text ?? "");
		if (paths.length === 0) return { action: "continue" };
		const images = paths.map(imageContentForPath).filter(Boolean);
		if (images.length === 0) return { action: "continue" };
		return { action: "transform", images: [...(event.images ?? []), ...images], text: event.text };
	});

	pi.registerCommand("qol", {
		description: "QOL status and attachment helpers: /qol status, /qol attachments, /qol reset.",
		handler: async (args, ctx) => {
			const sub = args.trim().toLowerCase() || "status";
			if (sub === "status") {
				ctx.ui.notify(statusMessage(ctx), "info");
				return;
			}
			if (sub === "attachments") {
				const labels = attachmentLabels(currentEditorText(ctx), ctx.cwd);
				ctx.ui.notify(labels.length ? labels.join("\n") : "No image placeholders or existing image paths in the current draft.", "info");
				return;
			}
			if (sub === "collapse") {
				ctx.ui.notify(collapseEditorImagePaths(ctx) ? "Collapsed image paths in the editor." : "No existing image paths found in the editor.", "info");
				return;
			}
			if (sub === "reset") {
				ctx.ui.setStatus(STATUS_KEY, undefined);
				ctx.ui.notify("Cleared QOL attachment status. Pi-owned pending images are unchanged.", "info");
				return;
			}
			ctx.ui.notify("Unknown /qol action. Try /qol status, /qol attachments, /qol collapse, or /qol reset.", "warning");
		},
	});
}
