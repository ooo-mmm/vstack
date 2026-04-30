import { CustomEditor, type ExtensionAPI, type ExtensionContext, type KeybindingsManager } from "@mariozechner/pi-coding-agent";
import type { EditorTheme, TUI } from "@mariozechner/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const INSTALL_SYMBOL = Symbol.for("vstack.pi-qol.installed");
const STATUS_KEY = "qol-attachments";
const DIM = "\x1b[38;5;8m";
const RESET = "\x1b[0m";

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

function attachmentLabels(text: string): string[] {
	const seen = new Set<string>();
	for (const match of text.matchAll(/\[Image\s+#(\d+)\]/gi)) {
		seen.add(`Image #${match[1]}`);
	}
	return [...seen].sort((a, b) => Number(a.replace(/\D/g, "")) - Number(b.replace(/\D/g, "")));
}

function chip(label: string, style: string): string {
	const text = ` ${label} `;
	if (style === "minimal") return `\x1b[38;5;45m${text}${RESET}`;
	if (style === "subtle") return `\x1b[48;5;236m\x1b[38;5;153m${text}${RESET}`;
	return `\x1b[48;5;27m\x1b[38;5;231m${text}${RESET}`;
}

function styleImageChips(line: string, cwd: string): string {
	if (!settingBoolean("showImageChips", true, cwd)) return line;
	const style = settingString("imageChipStyle", "filled", cwd);
	return line.replace(/\[Image\s+#(\d+)\]/gi, (_match, n) => chip(`Image #${n}`, style));
}

function statusText(ctx: ExtensionContext, text: string): string | undefined {
	if (!settingBoolean("showAttachmentCountInStatus", true, ctx.cwd)) return undefined;
	const count = attachmentLabels(text).length;
	return count > 0 ? `images:${count}` : undefined;
}

class QolEditor extends CustomEditor {
	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		private readonly ctx: ExtensionContext,
	) {
		super(tui, theme, keybindings);
	}

	handleInput(data: string): void {
		const fallback = settingString("newlineFallbackKey", "ctrl+j", this.ctx.cwd);
		const newlineEnabled = settingBoolean("newlineOnShiftEnter", true, this.ctx.cwd);
		const isShiftEnter = matchesKey(data, "shift+enter") || matchesKey(data, "shift+return");
		const isFallback = fallback !== "none" && matchesKey(data, fallback);
		if (newlineEnabled && (isShiftEnter || isFallback)) {
			super.handleInput("\n");
			this.refreshAttachmentStatus();
			return;
		}
		super.handleInput(data);
		this.refreshAttachmentStatus();
	}

	render(width: number): string[] {
		return super.render(width).map((line) => truncateToWidth(styleImageChips(line, this.ctx.cwd), width, ""));
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

function statusMessage(ctx: ExtensionContext): string {
	const cfg = readVstackConfig(ctx.cwd);
	const labels = attachmentLabels(currentEditorText(ctx));
	return [
		"Pi QOL status",
		`Shift+Enter newline: ${settingBoolean("newlineOnShiftEnter", true, ctx.cwd) ? "enabled" : "disabled"}`,
		`Fallback newline key: ${settingString("newlineFallbackKey", "ctrl+j", ctx.cwd)}`,
		`Image chips: ${settingBoolean("showImageChips", true, ctx.cwd) ? settingString("imageChipStyle", "filled", ctx.cwd) : "off"}`,
		`Attachment placeholders in draft: ${labels.length ? labels.join(", ") : "none"}`,
		`Hidden Thinking... placeholder setting: ${String(cfg.showHiddenThinkingPlaceholder ?? false)} (Pi API currently has no assistant-renderer hook, so this is a settings contract only.)`,
		"If Shift+Enter still submits, configure your terminal/tmux to send a distinct Shift+Enter sequence or use the fallback key.",
	].join("\n");
}

export default function qol(pi: ExtensionAPI): void {
	const guard = pi as unknown as Record<PropertyKey, unknown>;
	if (guard[INSTALL_SYMBOL]) return;
	guard[INSTALL_SYMBOL] = true;
	if (!settingBoolean("enabled", true)) return;

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setEditorComponent((tui, theme, keybindings) => new QolEditor(tui, theme, keybindings, ctx));
		const fallback = settingString("newlineFallbackKey", "ctrl+j", ctx.cwd);
		if (ctx.hasUI && fallback !== "none") {
			ctx.ui.notify(`QOL multiline input active. Shift+Enter inserts newline when your terminal reports it; fallback: ${fallback}.`, "info");
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
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
				const labels = attachmentLabels(currentEditorText(ctx));
				ctx.ui.notify(labels.length ? labels.join("\n") : "No image placeholders in the current draft.", "info");
				return;
			}
			if (sub === "reset") {
				ctx.ui.setStatus(STATUS_KEY, undefined);
				ctx.ui.notify("Cleared QOL attachment status. Pi-owned pending images are unchanged.", "info");
				return;
			}
			ctx.ui.notify("Unknown /qol action. Try /qol status, /qol attachments, or /qol reset.", "warning");
		},
	});
}
