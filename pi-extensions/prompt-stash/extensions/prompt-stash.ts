import {
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const DEFAULT_STORE_FILE = "prompt-stash.json";
const STORE_VERSION = 1;
const POPUP_WIDTH = 92;
const POPUP_MAX_HEIGHT = "80%";
const LIST_ROWS = 10;
const PADDING_X = 4;
const PADDING_Y = 2;
const INSTALL_SYMBOL = Symbol.for("vstack.prompt-stash.installed");

interface StashItem {
	id: string;
	text: string;
	createdAt: string;
}

interface StashStore {
	version: number;
	items: StashItem[];
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

function readVstackConfig(cwd?: string): VstackConfig {
	const merged: VstackConfig = {};
	for (const path of piSettingsPaths(cwd)) {
		if (!existsSync(path)) continue;
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			const config = parsed?.vstack?.extensionManager?.config?.["prompt-stash"];
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

function projectRoot(cwd: string): string {
	let current = resolve(cwd);
	while (true) {
		if (
			existsSync(join(current, ".git")) ||
			existsSync(join(current, ".vstack-lock.json")) ||
			existsSync(join(current, ".pi")) ||
			existsSync(join(current, ".agents"))
		) {
			return current;
		}
		const parent = dirname(current);
		if (parent === current) return resolve(cwd);
		current = parent;
	}
}

function storePath(ctx: ExtensionContext): string {
	return join(projectRoot(ctx.cwd), ".pi", settingString("storeFile", DEFAULT_STORE_FILE, ctx.cwd));
}

function loadItems(path: string): StashItem[] {
	if (!existsSync(path)) return [];
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<StashStore>;
		if (!Array.isArray(parsed.items)) return [];
		return parsed.items
			.filter((item): item is StashItem => {
				return Boolean(
					item &&
						typeof item === "object" &&
						typeof (item as StashItem).id === "string" &&
						typeof (item as StashItem).text === "string" &&
						typeof (item as StashItem).createdAt === "string",
				);
			})
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	} catch {
		return [];
	}
}

function saveItems(path: string, items: StashItem[]): void {
	mkdirSync(dirname(path), { recursive: true });
	const tempPath = `${path}.tmp-${process.pid}`;
	const store: StashStore = { version: STORE_VERSION, items };
	writeFileSync(tempPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
	renameSync(tempPath, path);
}

function makeId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function stashPrompt(ctx: ExtensionContext, text: string): number {
	const path = storePath(ctx);
	const now = new Date().toISOString();
	const loaded = loadItems(path);
	const existing = settingBoolean("deduplicate", true, ctx.cwd) ? loaded.filter((item) => item.text !== text) : loaded;
	const items = [{ id: makeId(), text, createdAt: now }, ...existing];
	saveItems(path, items);
	return items.length;
}

function lineCount(text: string): number {
	return Math.max(1, text.split(/\r\n|\r|\n/).length);
}

function previewText(text: string): string {
	const first = text
		.split(/\r\n|\r|\n/)
		.map((line) => line.trim())
		.find((line) => line.length > 0);
	return first ?? "(empty prompt)";
}

function padAnsi(text: string, width: number): string {
	const truncated = truncateToWidth(text, width, "");
	return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

function searchable(text: string): string {
	return text.toLowerCase();
}

function isPrintable(data: string): boolean {
	return data.length === 1 && data >= " " && data !== "\x7f";
}

function panelLine(content: string, width: number): string {
	return padAnsi(content, width);
}

function selectedLine(theme: Theme, content: string, width: number): string {
	return theme.bg("toolSuccessBg", padAnsi(theme.fg("text", content), width));
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

function renderSearchInput(query: string, cursor: number, width: number, theme: Theme): string {
	const safeWidth = Math.max(1, width);
	const safeCursor = Math.max(0, Math.min(cursor, query.length));
	const visibleQuery = query.length === 0 ? theme.fg("dim", "Search") : query;
	const before = query.length === 0 ? "" : query.slice(0, safeCursor);
	const cursorChar = query.length === 0 || safeCursor >= query.length ? "▌" : query[safeCursor];
	const after = query.length === 0 ? visibleQuery : safeCursor < query.length ? query.slice(safeCursor + 1) : "";
	const cursorGlyph = theme.fg("accent", cursorChar);
	const raw = `${theme.fg("borderMuted", "▏ ")}${before}${cursorGlyph}${after}`;
	return theme.bg("toolSuccessBg", padAnsi(raw, safeWidth));
}

function filterItems(items: StashItem[], query: string): StashItem[] {
	const trimmed = query.trim().toLowerCase();
	if (!trimmed) return items;
	return items.filter((item) => searchable(item.text).includes(trimmed));
}

async function openStashPopup(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;

	const listRows = Math.max(1, Math.floor(settingNumber("listRows", LIST_ROWS, ctx.cwd)));
	const path = storePath(ctx);
	let items = loadItems(path);
	if (items.length === 0) {
		ctx.ui.notify("Prompt stash is empty", "info");
		return;
	}

	const popped = await ctx.ui.custom<string | null>(
		(tui, theme, _keybindings, done) => {
			let query = "";
			let searchCursor = 0;
			let selected = 0;
			let scroll = 0;
			let confirmDeleteAll = false;

			const filtered = () => filterItems(items, query);
			const clampSelection = () => {
				const count = filtered().length;
				if (count === 0) {
					selected = 0;
					scroll = 0;
					return;
				}
				selected = Math.max(0, Math.min(selected, count - 1));
				if (selected < scroll) scroll = selected;
				if (selected >= scroll + listRows) scroll = selected - listRows + 1;
				scroll = Math.max(0, Math.min(scroll, Math.max(0, count - listRows)));
			};

			const deleteSelected = () => {
				const item = filtered()[selected];
				if (!item) return;
				items = items.filter((candidate) => candidate.id !== item.id);
				saveItems(path, items);
				clampSelection();
				tui.requestRender();
			};

			const clearAll = () => {
				items = [];
				saveItems(path, items);
				confirmDeleteAll = false;
				clampSelection();
				tui.requestRender();
			};

			const popSelected = () => {
				const item = filtered()[selected];
				if (!item) return;
				items = items.filter((candidate) => candidate.id !== item.id);
				saveItems(path, items);
				done(item.text);
			};

			const render = (width: number): string[] => {
				const innerWidth = popupContentWidth(width);
				const results = filtered();
				clampSelection();

				const lines: string[] = [];
				const title = `${theme.fg("accent", theme.bold("⚑ Prompt stash"))} ${theme.fg("muted", `${items.length} saved`)}`;
				const esc = theme.fg("dim", "esc");
				const titleGap = Math.max(1, innerWidth - visibleWidth(`⚑ Prompt stash ${items.length} saved`) - visibleWidth("esc"));
				lines.push(panelLine(`${title}${" ".repeat(titleGap)}${esc}`, innerWidth));
				lines.push(panelLine(theme.fg("dim", "Type to search · ↑↓/jk select · enter pop · ctrl+d delete · ctrl+x delete all"), innerWidth));
				lines.push(panelLine("", innerWidth));
				lines.push(panelLine(renderSearchInput(query, searchCursor, innerWidth, theme), innerWidth));
				lines.push(panelLine("", innerWidth));

				if (results.length === 0) {
					lines.push(panelLine(theme.fg("dim", "No matching stashed prompts"), innerWidth));
				} else {
					for (const [visibleIndex, item] of results.slice(scroll, scroll + listRows).entries()) {
						const index = scroll + visibleIndex;
						const count = lineCount(item.text);
						const countText = `~${count} ${count === 1 ? "line" : "lines"}`;
						const countWidth = visibleWidth(countText);
						const rowWidth = innerWidth;
						const marker = index === selected ? theme.fg("accent", "› ") : "  ";
						const markerWidth = visibleWidth("› ");
						const previewWidth = Math.max(1, rowWidth - markerWidth - countWidth - 2);
						const preview = truncateToWidth(previewText(item.text), previewWidth, "");
						const styledPreview = index === selected ? theme.bold(preview) : preview;
						const styledCount = index === selected ? theme.fg("text", countText) : theme.fg("dim", countText);
						const row = `${marker}${styledPreview}${" ".repeat(Math.max(1, rowWidth - markerWidth - visibleWidth(preview) - countWidth))}${styledCount}`;
						lines.push(index === selected ? selectedLine(theme, row, innerWidth) : panelLine(row, innerWidth));
					}
				}

				const emptyRows = Math.max(0, listRows - Math.max(1, Math.min(results.length, listRows)));
				for (let i = 0; i < emptyRows; i += 1) lines.push(panelLine("", innerWidth));

				lines.push(panelLine("", innerWidth));
				const status = confirmDeleteAll
					? `${theme.fg("warning", "delete all stashed prompts?")} ${theme.fg("text", "y")} ${theme.fg("dim", "/ n")}`
					: `${theme.fg("text", "enter")} ${theme.fg("dim", "pop")}  ${theme.fg("text", "delete")} ${theme.fg("dim", "ctrl+d")}  ${theme.fg("text", "delete all")} ${theme.fg("dim", "ctrl+x")}`;
				lines.push(panelLine(status, innerWidth));

				return framePopup(lines, width, theme);
			};

			return {
				handleInput(data: string) {
					if (confirmDeleteAll) {
						if (data === "y" || data === "Y") {
							clearAll();
							return;
						}
						if (data === "n" || data === "N" || matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
							confirmDeleteAll = false;
							tui.requestRender();
							return;
						}
					}

					if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
						done(null);
						return;
					}
					if (matchesKey(data, "return") || matchesKey(data, "enter")) {
						popSelected();
						return;
					}
					if (matchesKey(data, "up") || data === "k") {
						selected -= 1;
						clampSelection();
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "down") || data === "j") {
						selected += 1;
						clampSelection();
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "pageup")) {
						selected -= listRows;
						clampSelection();
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "pagedown")) {
						selected += listRows;
						clampSelection();
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "ctrl+d") || matchesKey(data, "delete")) {
						deleteSelected();
						return;
					}
					if (matchesKey(data, "ctrl+x")) {
						confirmDeleteAll = items.length > 0;
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "left")) {
						searchCursor = Math.max(0, searchCursor - 1);
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "right")) {
						searchCursor = Math.min(query.length, searchCursor + 1);
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "home") || matchesKey(data, "ctrl+a")) {
						searchCursor = 0;
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "end") || matchesKey(data, "ctrl+e")) {
						searchCursor = query.length;
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "backspace")) {
						if (searchCursor > 0) {
							query = `${query.slice(0, searchCursor - 1)}${query.slice(searchCursor)}`;
							searchCursor -= 1;
							selected = 0;
							clampSelection();
							tui.requestRender();
						}
						return;
					}
					if (matchesKey(data, "ctrl+u")) {
						query = "";
						searchCursor = 0;
						selected = 0;
						clampSelection();
						tui.requestRender();
						return;
					}
					if (isPrintable(data)) {
						query = `${query.slice(0, searchCursor)}${data}${query.slice(searchCursor)}`;
						searchCursor += data.length;
						selected = 0;
						clampSelection();
						tui.requestRender();
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

	if (popped != null) {
		ctx.ui.setEditorText(popped);
	}
}

let stashShortcutOpen = false;

async function toggleStash(ctx: ExtensionContext): Promise<void> {
	if (stashShortcutOpen) return;
	const text = ctx.ui.getEditorText?.() ?? "";
	if (text.trim().length > 0) {
		const count = stashPrompt(ctx, text);
		ctx.ui.setEditorText("");
		ctx.ui.notify(`Stashed prompt (${count} total)`, "info");
		return;
	}

	stashShortcutOpen = true;
	try {
		await openStashPopup(ctx);
	} finally {
		stashShortcutOpen = false;
	}
}

export default function promptStash(pi: ExtensionAPI): void {
	const guard = pi as unknown as Record<PropertyKey, unknown>;
	if (guard[INSTALL_SYMBOL]) return;
	guard[INSTALL_SYMBOL] = true;
	if (!settingBoolean("enabled", true)) return;

	const shortcut = settingString("shortcut", "ctrl+s");
	if (shortcut !== "none") {
		pi.registerShortcut(shortcut, {
			description: "Stash current prompt or pop from prompt stash",
			handler: async (ctx) => toggleStash(ctx as ExtensionContext),
		});
	}

	pi.registerCommand("prompt-stash", {
		description: "Open the project-local prompt stash popup",
		handler: async (_args, ctx) => openStashPopup(ctx),
	});
}
