import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const CONFIG_ID = "@vanillagreen/pi-tool-renderer";

export type VstackConfig = Record<string, unknown>;

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

export function readVstackConfig(cwd?: string): VstackConfig {
	const merged: VstackConfig = {};
	for (const path of piSettingsPaths(cwd)) {
		if (!existsSync(path)) continue;
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			const config = parsed?.vstack?.extensionManager?.config?.[CONFIG_ID];
			if (config && typeof config === "object" && !Array.isArray(config)) Object.assign(merged, config);
		} catch {
			// Ignore malformed optional manager config.
		}
	}
	return merged;
}

export function settingNumber(key: string, fallback: number, cwd?: string): number {
	const value = readVstackConfig(cwd)[key];
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : fallback;
}

export function settingBoolean(key: string, fallback: boolean, cwd?: string): boolean {
	const value = readVstackConfig(cwd)[key];
	return typeof value === "boolean" ? value : fallback;
}

export function settingString(key: string, fallback: string, cwd?: string): string {
	const value = readVstackConfig(cwd)[key];
	return typeof value === "string" ? value : fallback;
}

export function settingEnum<T extends string>(key: string, allowed: readonly T[], fallback: T, cwd?: string): T {
	const value = readVstackConfig(cwd)[key];
	return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

export function rightMarginGuardEnabled(cwd?: string): boolean {
	return settingBoolean("rightMarginGuard", true, cwd);
}

export function stackToolCalls(cwd?: string): boolean {
	return settingBoolean("stackToolCalls", false, cwd);
}

export type StackChildDisplay = "rows" | "headline" | "anchor-list";

export function stackChildDisplay(cwd?: string): StackChildDisplay {
	const value = readVstackConfig(cwd).stackChildDisplay;
	if (value === "rows" || value === "headline" || value === "anchor-list") return value;
	return settingBoolean("hideStackChildRows", false, cwd) ? "headline" : "rows";
}

export function stackShell(cwd?: string): { renderShell?: "self" } {
	return stackToolCalls(cwd) ? { renderShell: "self" } : {};
}

export type ReadOutputMode = "hidden" | "summary" | "preview";
export type SearchOutputMode = "hidden" | "count" | "preview";
export type BashOutputMode = "hidden" | "summary" | "opencode" | "preview";
export type McpOutputMode = "hidden" | "summary" | "preview";

export function readOutputMode(cwd?: string): ReadOutputMode {
	return settingEnum("readOutputMode", ["hidden", "summary", "preview"] as const, "preview", cwd);
}

export function searchOutputMode(cwd?: string): SearchOutputMode {
	return settingEnum("searchOutputMode", ["hidden", "count", "preview"] as const, "preview", cwd);
}

export function bashOutputMode(cwd?: string): BashOutputMode {
	return settingEnum("bashOutputMode", ["hidden", "summary", "opencode", "preview"] as const, "opencode", cwd);
}

export function mcpOutputMode(cwd?: string): McpOutputMode {
	return settingEnum("mcpOutputMode", ["hidden", "summary", "preview"] as const, "preview", cwd);
}

export type TreeStyle = "unicode" | "ascii";

export function treeStyle(cwd?: string): TreeStyle {
	return settingEnum("treeStyle", ["unicode", "ascii"] as const, "unicode", cwd);
}

export function pendingStatusAnimation(cwd?: string): boolean {
	return settingBoolean("pendingStatusAnimation", false, cwd);
}

export function diffBackgroundEnabled(cwd?: string): boolean {
	return settingBoolean("diffBackgrounds", true, cwd);
}

export function bashDiffRenderingEnabled(cwd?: string): boolean {
	return settingBoolean("renderBashDiffs", false, cwd);
}

export type ToolChromeMode = "off" | "transparent" | "outlines";

export function toolChromeMode(cwd?: string): ToolChromeMode {
	return settingEnum("toolChrome", ["off", "transparent", "outlines"] as const, "outlines", cwd);
}
