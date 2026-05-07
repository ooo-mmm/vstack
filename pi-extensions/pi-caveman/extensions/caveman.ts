import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const INSTALL_SYMBOL = Symbol.for("vstack.pi-caveman.installed");
const BRIDGE_SYMBOL = Symbol.for("vstack.pi.caveman");
const STATE_TYPE = "vstack-caveman:state";
const STATUS_KEY = "caveman";
const CONFIG_ID = "@vanillagreen/pi-caveman";
const SETTINGS_EVENT = "vstack:extension-settings-changed";

type Mode = "off" | "lite" | "full" | "ultra" | "micro";
type ActiveMode = Exclude<Mode, "off">;
type VstackConfig = Record<string, unknown>;

const MODE_VALUES: readonly Mode[] = ["off", "lite", "full", "ultra", "micro"];

interface CavemanBridge {
	isActive(): boolean;
	getMode(): Mode;
	getConfiguredMode(cwd?: string): Mode;
	getLastActiveMode(): ActiveMode;
	hasSessionOverride(): boolean;
	isStatusBadgeEnabled(cwd?: string): boolean;
	cycleMode(cwd?: string): Mode;
	setMode(mode: string, cwd?: string): Mode | undefined;
	subscribe(listener: () => void): () => void;
}

const CYCLE_ORDER: readonly Mode[] = ["off", "lite", "full", "ultra", "micro"];

const SUBCOMMAND_DESCRIPTIONS: Record<string, string> = {
	lite: "Caveman lite — professional, no fluff",
	full: "Caveman full — classic caveman",
	ultra: "Caveman ultra — maximum compression",
	micro: "Caveman micro — prompt-minimized compression",
	toggle: "Toggle caveman mode on/off",
};

interface CavemanState {
	override: Mode | null;
	lastActiveMode: ActiveMode;
	updatedAt: string;
}

interface PersistedState {
	override?: Mode | null;
	lastActiveMode?: Mode;
	updatedAt?: string;
	mode?: Mode;
	source?: "default" | "session";
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
			const config = parsed?.vstack?.extensionManager?.config?.[CONFIG_ID];
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
	if (MODE_VALUES.includes(mode as Mode)) return mode as Mode;
	return undefined;
}

function normalizeActiveMode(input: string | undefined): ActiveMode | undefined {
	const mode = normalizeMode(input);
	return mode && mode !== "off" ? mode : undefined;
}

function configuredMode(cwd?: string): Mode {
	const config = readVstackConfig(cwd);
	const explicit = normalizeMode(typeof config.mode === "string" ? config.mode : undefined);
	if (explicit) return explicit;
	const legacyEnabled = typeof config.enabled === "boolean" ? config.enabled : false;
	if (!legacyEnabled) return "off";
	return normalizeActiveMode(typeof config.defaultMode === "string" ? config.defaultMode : undefined) ?? "full";
}

function effectiveMode(state: CavemanState, cwd?: string): Mode {
	return state.override ?? configuredMode(cwd);
}

function initialState(cwd?: string): CavemanState {
	const configured = configuredMode(cwd);
	return {
		override: null,
		lastActiveMode: configured === "off" ? "full" : configured,
		updatedAt: new Date().toISOString(),
	};
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
	if (mode === "micro") {
		const compactBoundaries: string[] = [];
		if (settingBoolean("boundaryNormalForCode", true, cwd)) compactBoundaries.push("Code/commands/identifiers/quoted errors unchanged.");
		if (settingBoolean("boundaryNormalForCommits", true, cwd)) compactBoundaries.push("Commit/PR text normal unless user asks caveman.");
		if (settingBoolean("boundaryNormalForReviews", true, cwd)) compactBoundaries.push("Formal reviews normal unless user asks caveman.");
		return [
			"Token efficiency mode: terse smart caveman.",
			"Cut filler/pleasantries/hedging. Fragments OK. Technical terms exact. Accuracy > brevity.",
			"Use normal clarity for security/destructive/ambiguous turns, then resume.",
			...compactBoundaries,
			suffix,
		].filter(Boolean).join("\n");
	}
	const modeText: Record<Exclude<Mode, "off" | "micro">, string> = {
		lite: "Lite: remove filler, hedging, and pleasantries. Keep articles and professional complete sentences, but be tight.",
		full: "Full: terse smart caveman. Drop articles/filler/hedging. Fragments OK. Pattern: [thing] [action] [reason]. [next step]. Technical terms exact.",
		ultra: "Ultra: maximum terse English. Abbreviate common technical words, use arrows for causality, one word when one word enough. Preserve exact technical terms.",
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
		const data = entry.data as PersistedState | undefined;
		if (!data) continue;
		let override: Mode | null;
		if (data.override === null) {
			override = null;
		} else if (typeof data.override === "string") {
			override = normalizeMode(data.override) ?? null;
		} else if (typeof data.mode === "string") {
			const legacyMode = normalizeMode(data.mode);
			override = data.source === "session" && legacyMode ? legacyMode : null;
		} else {
			override = state.override;
		}
		const lastActiveMode = normalizeActiveMode(data.lastActiveMode)
			?? (override && override !== "off" ? override : state.lastActiveMode);
		state = {
			override,
			lastActiveMode,
			updatedAt: data.updatedAt ?? new Date().toISOString(),
		};
	}
	return state;
}

function statusText(state: CavemanState, cwd?: string): string {
	const mode = effectiveMode(state, cwd);
	const suffix = state.override === null ? " (default)" : " (session)";
	return mode === "off" ? `Caveman off${suffix}.` : `Caveman ${mode} active${suffix}.`;
}

export default function caveman(pi: ExtensionAPI): void {
	const guard = pi as unknown as Record<PropertyKey, unknown>;
	if (guard[INSTALL_SYMBOL]) return;
	guard[INSTALL_SYMBOL] = true;

	let state: CavemanState = initialState();
	let activeCtx: ExtensionContext | undefined;
	const listeners = new Set<() => void>();
	const notifyListeners = () => {
		for (const listener of [...listeners]) {
			try { listener(); } catch { /* swallow listener errors */ }
		}
	};

	const host = globalThis as unknown as Record<PropertyKey, unknown>;
	const applyOverride = (mode: Mode, cwd?: string): Mode | undefined => {
		if (!settingBoolean("sessionOverrideAllowed", true, cwd)) return undefined;
		const lastActiveMode: ActiveMode = mode === "off" ? state.lastActiveMode : mode;
		state = { override: mode, lastActiveMode, updatedAt: new Date().toISOString() };
		persist();
		syncStatus(activeCtx);
		notifyListeners();
		return mode;
	};

	const bridge: CavemanBridge = {
		isActive: () => effectiveMode(state, activeCtx?.cwd) !== "off",
		getMode: () => effectiveMode(state, activeCtx?.cwd),
		getConfiguredMode: (cwd) => configuredMode(cwd ?? activeCtx?.cwd),
		getLastActiveMode: () => state.lastActiveMode,
		hasSessionOverride: () => state.override !== null,
		isStatusBadgeEnabled: (cwd) => settingBoolean("showStatusBadge", true, cwd),
		cycleMode: (cwd) => {
			const current = effectiveMode(state, cwd ?? activeCtx?.cwd);
			const index = CYCLE_ORDER.indexOf(current);
			const next = CYCLE_ORDER[(index + 1) % CYCLE_ORDER.length] ?? "off";
			return applyOverride(next, cwd ?? activeCtx?.cwd) ?? current;
		},
		setMode: (mode, cwd) => {
			const parsed = normalizeMode(mode);
			if (!parsed) return undefined;
			return applyOverride(parsed, cwd ?? activeCtx?.cwd);
		},
		subscribe: (listener) => {
			listeners.add(listener);
			return () => { listeners.delete(listener); };
		},
	};
	host[BRIDGE_SYMBOL] = bridge;

	const persist = () => pi.appendEntry<CavemanState>(STATE_TYPE, { ...state, updatedAt: new Date().toISOString() });
	const syncStatus = (ctx?: ExtensionContext) => {
		const runCtx = ctx ?? activeCtx;
		if (!runCtx?.hasUI) return;
		const mode = effectiveMode(state, runCtx.cwd);
		runCtx.ui.setStatus(STATUS_KEY, settingBoolean("showStatusBadge", true, runCtx.cwd) ? statusLabel(mode) : undefined);
	};

	pi.on("session_start", (_event, ctx) => {
		activeCtx = ctx;
		state = restoreState(ctx);
		syncStatus(ctx);
		notifyListeners();
	});
	pi.on("session_tree", (_event, ctx) => {
		activeCtx = ctx;
		state = restoreState(ctx);
		syncStatus(ctx);
		notifyListeners();
	});
	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		notifyListeners();
	});

	const applySubcommand = async (sub: string, ctx: ExtensionContext) => {
		activeCtx = ctx;
		const arg = sub.trim().toLowerCase();
		if (arg === "status") {
			ctx.ui.notify(statusText(state, ctx.cwd), "info");
			return;
		}
		const current = effectiveMode(state, ctx.cwd);
		let nextOverride: Mode;
		if (!arg || arg === "toggle") {
			nextOverride = current === "off" ? state.lastActiveMode : "off";
		} else {
			const parsed = normalizeMode(arg);
			if (!parsed) {
				ctx.ui.notify("Unknown caveman mode. Try lite, full, ultra, micro, toggle, off, or status.", "warning");
				return;
			}
			nextOverride = parsed;
		}
		if (!settingBoolean("sessionOverrideAllowed", true, ctx.cwd)) {
			ctx.ui.notify("Session override disabled in caveman settings.", "warning");
			return;
		}
		const lastActiveMode: ActiveMode = nextOverride === "off" ? state.lastActiveMode : nextOverride;
		state = { override: nextOverride, lastActiveMode, updatedAt: new Date().toISOString() };
		persist();
		syncStatus(ctx);
		notifyListeners();
		ctx.ui.notify(nextOverride === "off" ? "Caveman off." : `Caveman ${nextOverride} active.`, "info");
	};

	pi.registerCommand("caveman", {
		description: "Token-efficient caveman response mode.",
		handler: async (args, ctx) => applySubcommand(args, ctx),
	});

	for (const sub of ["lite", "full", "ultra", "micro", "toggle"] as const) {
		pi.registerCommand(`caveman:${sub}`, {
			description: SUBCOMMAND_DESCRIPTIONS[sub],
			handler: async (_args, ctx) => applySubcommand(sub, ctx),
		});
	}

	pi.events.on(SETTINGS_EVENT, (data: unknown) => {
		if (!data || typeof data !== "object") return;
		const event = data as { extensionId?: unknown; key?: unknown };
		if (event.extensionId !== CONFIG_ID) return;
		if (event.key === "mode") {
			const configured = configuredMode(activeCtx?.cwd);
			const lastActiveMode: ActiveMode = configured === "off" ? state.lastActiveMode : configured;
			state = { override: null, lastActiveMode, updatedAt: new Date().toISOString() };
			persist();
		}
		syncStatus(activeCtx);
		notifyListeners();
	});

	pi.on("before_agent_start", (event, ctx) => {
		activeCtx = ctx;
		const mode = effectiveMode(state, ctx.cwd);
		if (mode === "off") {
			syncStatus(ctx);
			return undefined;
		}
		const clarity = settingBoolean("autoClarityEscape", true, ctx.cwd) && shouldClarityEscape(event.prompt ?? "");
		const prompt = instructions(mode, ctx.cwd, clarity);
		if (clarity && !settingBoolean("resumeAfterClarityEscape", true, ctx.cwd)) {
			state = { override: "off", lastActiveMode: state.lastActiveMode, updatedAt: new Date().toISOString() };
			persist();
			notifyListeners();
		}
		syncStatus(ctx);
		return { systemPrompt: `${event.systemPrompt}\n\n${prompt}` };
	});
}
