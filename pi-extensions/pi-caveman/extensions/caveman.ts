import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const INSTALL_SYMBOL = Symbol.for("vstack.pi-caveman.installed");
const STATE_TYPE = "vstack-caveman:state";
const STATUS_KEY = "caveman";

type Mode = "off" | "lite" | "full" | "ultra" | "wenyan-lite" | "wenyan-full" | "wenyan-ultra";
type VstackConfig = Record<string, unknown>;

interface CavemanState {
	mode: Mode;
	source: "default" | "session";
	updatedAt: string;
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
			const config = parsed?.vstack?.extensionManager?.config?.["pi-caveman"];
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
	return typeof value === "string" ? value : fallback;
}

function normalizeMode(input: string | undefined): Mode | undefined {
	const mode = (input ?? "").trim().toLowerCase();
	if (mode === "wenyan") return "wenyan-full";
	if (["off", "lite", "full", "ultra", "wenyan-lite", "wenyan-full", "wenyan-ultra"].includes(mode)) return mode as Mode;
	return undefined;
}

function defaultMode(cwd?: string): Mode {
	return normalizeMode(settingString("defaultMode", "full", cwd)) ?? "full";
}

function initialState(cwd?: string): CavemanState {
	return { mode: settingBoolean("enabled", false, cwd) ? defaultMode(cwd) : "off", source: "default", updatedAt: new Date().toISOString() };
}

function statusLabel(mode: Mode): string | undefined {
	if (mode === "off") return undefined;
	if (mode === "full") return "CAVEMAN";
	return `CAVEMAN:${mode.toUpperCase()}`;
}

function shouldClarityEscape(prompt: string): boolean {
	return /(security|vulnerab|exploit|secret|token|password|credential|delete|drop\s+table|rm\s+-rf|destructive|irreversible|danger|confirm|clarify|confused|explain again|not clear|ambiguous)/i.test(prompt);
}

function instructions(mode: Mode, cwd: string, clarityEscape: boolean): string {
	if (mode === "off") return "";
	const boundaries: string[] = [];
	if (settingBoolean("boundaryNormalForCode", true, cwd)) boundaries.push("Code and code blocks stay normal; do not caveman-transform code, commands, identifiers, or quoted errors.");
	if (settingBoolean("boundaryNormalForCommits", true, cwd)) boundaries.push("Commit messages and PR descriptions stay normal unless user explicitly asks for caveman style there.");
	if (settingBoolean("boundaryNormalForReviews", true, cwd)) boundaries.push("Formal reviews stay normal unless user explicitly asks for caveman style there.");
	const suffix = settingString("customPromptSuffix", "", cwd).trim();
	if (clarityEscape) {
		return [
			"Caveman mode is active, but this turn appears to need safety/clarity. Use normal clear prose for warnings, irreversible actions, or clarification. After clear part, you may add a short 'Caveman resume.' note.",
			...boundaries,
			suffix,
		].filter(Boolean).join("\n");
	}
	const modeText: Record<Exclude<Mode, "off">, string> = {
		lite: "Lite: remove filler, hedging, and pleasantries. Keep articles and professional complete sentences, but be tight.",
		full: "Full: terse smart caveman. Drop articles/filler/hedging. Fragments OK. Pattern: [thing] [action] [reason]. [next step]. Technical terms exact.",
		ultra: "Ultra: maximum terse English. Abbreviate common technical words, use arrows for causality, one word when one word enough. Preserve exact technical terms.",
		"wenyan-lite": "Wenyan-lite: concise semi-classical Chinese register. Drop filler/hedging, keep clarity and technical terms exact.",
		"wenyan-full": "Wenyan-full: maximum classical terseness. Classical Chinese style, subjects often omitted, preserve technical terms/code exact.",
		"wenyan-ultra": "Wenyan-ultra: extreme compact classical Chinese feel. Maximum compression while preserving correctness and technical identifiers.",
	};
	return [
		"Caveman communication mode active for assistant natural-language chat.",
		modeText[mode],
		"No pleasantries. No filler. No unnecessary hedging. Accuracy over terseness if conflict.",
		"Auto-clarity rule: for security warnings, irreversible actions, confusing multi-step sequences, or user confusion, temporarily use normal clarity; resume caveman after clear part.",
		...boundaries,
		suffix,
	].filter(Boolean).join("\n");
}

function restoreState(ctx: ExtensionContext): CavemanState {
	let state = initialState(ctx.cwd);
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== STATE_TYPE) continue;
		const data = entry.data as Partial<CavemanState> | undefined;
		const mode = normalizeMode(data?.mode);
		if (mode) state = { mode, source: data?.source === "default" ? "default" : "session", updatedAt: data?.updatedAt ?? new Date().toISOString() };
	}
	return state;
}

function statusText(state: CavemanState): string {
	return state.mode === "off" ? `caveman off (${state.source})` : `caveman ${state.mode} (${state.source})`;
}

export default function caveman(pi: ExtensionAPI): void {
	const guard = pi as unknown as Record<PropertyKey, unknown>;
	if (guard[INSTALL_SYMBOL]) return;
	guard[INSTALL_SYMBOL] = true;

	let state: CavemanState = initialState();
	let activeCtx: ExtensionContext | undefined;

	const persist = () => pi.appendEntry<CavemanState>(STATE_TYPE, { ...state, updatedAt: new Date().toISOString() });
	const syncStatus = (ctx?: ExtensionContext) => {
		const runCtx = ctx ?? activeCtx;
		if (!runCtx?.hasUI) return;
		runCtx.ui.setStatus(STATUS_KEY, settingBoolean("showStatusBadge", true, runCtx.cwd) ? statusLabel(state.mode) : undefined);
	};

	pi.on("session_start", (_event, ctx) => {
		activeCtx = ctx;
		state = restoreState(ctx);
		syncStatus(ctx);
	});
	pi.on("session_tree", (_event, ctx) => {
		activeCtx = ctx;
		state = restoreState(ctx);
		syncStatus(ctx);
	});
	pi.on("session_shutdown", (_event, ctx) => ctx.ui.setStatus(STATUS_KEY, undefined));

	pi.registerCommand("caveman", {
		description: "Control caveman mode: /caveman [lite|full|ultra|wenyan-full|off|status]",
		handler: async (args, ctx) => {
			activeCtx = ctx;
			const arg = args.trim().toLowerCase();
			if (!arg || arg === "status") {
				if (!arg && state.mode === "off") {
					if (!settingBoolean("sessionOverrideAllowed", true, ctx.cwd)) {
						ctx.ui.notify("Session override disabled in caveman settings.", "warning");
						return;
					}
					state = { mode: defaultMode(ctx.cwd), source: "session", updatedAt: new Date().toISOString() };
					persist();
					syncStatus(ctx);
					ctx.ui.notify(`Caveman ${state.mode} enabled.`, "info");
					return;
				}
				ctx.ui.notify(statusText(state), "info");
				return;
			}
			const mode = normalizeMode(arg);
			if (!mode) {
				ctx.ui.notify("Unknown caveman mode. Use off, lite, full, ultra, wenyan-lite, wenyan-full/wenyan, or wenyan-ultra.", "warning");
				return;
			}
			if (!settingBoolean("sessionOverrideAllowed", true, ctx.cwd)) {
				ctx.ui.notify("Session override disabled in caveman settings.", "warning");
				return;
			}
			state = { mode, source: "session", updatedAt: new Date().toISOString() };
			persist();
			syncStatus(ctx);
			ctx.ui.notify(mode === "off" ? "Caveman off." : `Caveman ${mode} active.`, "info");
		},
	});

	pi.on("before_agent_start", (event, ctx) => {
		activeCtx = ctx;
		if (state.source === "default") state = initialState(ctx.cwd);
		if (state.mode === "off") {
			syncStatus(ctx);
			return undefined;
		}
		const clarity = settingBoolean("autoClarityEscape", true, ctx.cwd) && shouldClarityEscape(event.prompt ?? "");
		const prompt = instructions(state.mode, ctx.cwd, clarity);
		if (clarity && !settingBoolean("resumeAfterClarityEscape", true, ctx.cwd)) {
			state = { mode: "off", source: "session", updatedAt: new Date().toISOString() };
			persist();
		}
		syncStatus(ctx);
		return { systemPrompt: `${event.systemPrompt}\n\n${prompt}` };
	});
}
