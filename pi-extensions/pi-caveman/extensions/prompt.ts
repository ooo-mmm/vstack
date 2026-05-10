// Pure prompt-rendering logic for pi-caveman. Kept free of pi-coding-agent
// imports so it can be unit-tested without a Pi runtime. Settings reads are
// driven by `cwd` plus the `PI_CODING_AGENT_DIR` env var, exactly as pi-core
// resolves them at runtime.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type Mode = "off" | "lite" | "full" | "ultra" | "micro";
export type ActiveMode = Exclude<Mode, "off">;
export type VstackConfig = Record<string, unknown>;

export const MODE_VALUES: readonly Mode[] = ["off", "lite", "full", "ultra", "micro"];
export const CONFIG_ID = "@vanillagreen/pi-caveman";

export function expandHome(input: string): string {
	if (input === "~") return homedir();
	if (input.startsWith("~/")) return join(homedir(), input.slice(2));
	return input;
}

export function projectSettingsPath(cwd: string): string {
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

export function piSettingsPaths(cwd = process.cwd()): string[] {
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

export function settingBoolean(key: string, fallback: boolean, cwd?: string): boolean {
	const value = readVstackConfig(cwd)[key];
	return typeof value === "boolean" ? value : fallback;
}

export function settingString(key: string, fallback: string, cwd?: string): string {
	const value = readVstackConfig(cwd)[key];
	return typeof value === "string" ? value : fallback;
}

export interface ConfigurationSource {
	source: "user" | "project" | "default";
	path?: string;
	userPath: string;
	projectPath: string;
	legacyKeys: string[];
}

// Walks user → project settings.json files (matching readVstackConfig order)
// and reports which file's `mode` key won the merge, plus any legacy keys
// (`enabled`, `defaultMode`) present alongside `mode`. Project wins on tie.
export function configurationSource(cwd?: string): ConfigurationSource {
	const [userPath, projectPath] = piSettingsPaths(cwd);
	const legacyKeys = new Set<string>();
	let sourcePath: string | undefined;
	let sourceLabel: "user" | "project" | "default" = "default";
	for (const [label, path] of [["user", userPath], ["project", projectPath]] as const) {
		if (!existsSync(path)) continue;
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			const config = parsed?.vstack?.extensionManager?.config?.[CONFIG_ID];
			if (!config || typeof config !== "object" || Array.isArray(config)) continue;
			if (typeof config.mode === "string") {
				sourceLabel = label;
				sourcePath = path;
			}
			for (const key of ["enabled", "defaultMode"]) {
				if (key in config) legacyKeys.add(key);
			}
		} catch {
			// Ignore malformed optional manager config.
		}
	}
	return { source: sourceLabel, path: sourcePath, userPath, projectPath, legacyKeys: [...legacyKeys] };
}

// Best-effort read of the pi-claude-bridge extension-manager setting that
// controls whether the caveman block is forwarded into Claude's prompt.
// Does not consult bridge's own claude-bridge.json file (a separate channel);
// /caveman debug surfaces this caveat.
export function bridgeCavemanHookEnabled(cwd?: string): boolean | undefined {
	let value: boolean | undefined;
	for (const path of piSettingsPaths(cwd)) {
		if (!existsSync(path)) continue;
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			const config = parsed?.vstack?.extensionManager?.config?.["@vanillagreen/pi-claude-bridge"];
			if (config && typeof config === "object" && !Array.isArray(config) && typeof config.includeCavemanHook === "boolean") {
				value = config.includeCavemanHook;
			}
		} catch {
			// Ignore malformed optional manager config.
		}
	}
	return value;
}

export function normalizeMode(input: string | undefined): Mode | undefined {
	const mode = (input ?? "").trim().toLowerCase();
	if (MODE_VALUES.includes(mode as Mode)) return mode as Mode;
	return undefined;
}

export function normalizeActiveMode(input: string | undefined): ActiveMode | undefined {
	const mode = normalizeMode(input);
	return mode && mode !== "off" ? mode : undefined;
}

// Trigger normal-clarity prose for security topics, explicit destructive
// shell/SQL commands, explicit warning vocabulary, and clear user-confusion
// signals. Do not match common verbs like `delete` or `confirm` on their own —
// in a coding context they appear in routine work and produced false escapes
// every turn.
export function shouldClarityEscape(prompt: string): boolean {
	return /(security|vulnerab|exploit|secret|token|password|credential|drop\s+table|rm\s+-rf|force[- ]?push|git\s+reset\s+--hard|destructive|irreversible|\bdanger(ous)?\b|clarify|confused|explain again|not clear|ambiguous)/i.test(prompt);
}

export function instructions(mode: Mode, cwd: string, clarityEscape: boolean): string {
	if (mode === "off") return "";
	const boundaries: string[] = [];
	if (settingBoolean("boundaryNormalForCode", true, cwd)) boundaries.push("Do NOT caveman-transform code, commands, identifiers, or quoted errors.");
	if (settingBoolean("boundaryNormalForCommits", true, cwd)) boundaries.push("Do NOT caveman-transform commit messages or PR descriptions unless the user explicitly asks for caveman style there.");
	if (settingBoolean("boundaryNormalForReviews", true, cwd)) boundaries.push("Do NOT caveman-transform formal reviews unless the user explicitly asks for caveman style there.");
	const suffix = settingString("customPromptSuffix", "", cwd).trim();

	if (clarityEscape) {
		// Sentinel directive is intentionally the LAST line so it gets recency
		// bias — live testing showed the model dropped the sentinel when it
		// sat in the middle of the block (F2 in pi-caveman-improvement-plan.md).
		return [
			`You MUST respond in caveman ${mode} style for natural-language replies — but this turn needs safety/clarity, so use normal clear prose for the entire reply.`,
			"Do NOT produce caveman-styled prose this turn.",
			...boundaries,
			suffix,
			"You MUST end your reply with exactly one line containing only the literal two-word text Caveman resume (no period, no quotes, no extra words on that line, no caveman-translated summary). This is non-negotiable — emit the sentinel even if you forgot everything else above.",
		].filter(Boolean).join("\n");
	}

	if (mode === "micro") {
		const compactBoundaries: string[] = [];
		if (settingBoolean("boundaryNormalForCode", true, cwd)) compactBoundaries.push("Code/commands/identifiers/quoted errors unchanged.");
		if (settingBoolean("boundaryNormalForCommits", true, cwd)) compactBoundaries.push("Commit/PR text normal unless user asks caveman.");
		if (settingBoolean("boundaryNormalForReviews", true, cwd)) compactBoundaries.push("Formal reviews normal unless user asks caveman.");
		return [
			"You MUST respond in caveman micro style.",
			"Cut filler/pleasantries/hedging. Fragments OK. Technical terms exact. Accuracy > brevity.",
			"For security/destructive/ambiguous turns, switch to normal clarity, then resume.",
			...compactBoundaries,
			suffix,
		].filter(Boolean).join("\n");
	}

	const modeText: Record<Exclude<Mode, "off" | "micro">, string> = {
		lite: "Tight professional prose with COMPLETE sentences (no fragments — fragments are full mode). Active voice. Strip filler words ('basically', 'essentially', 'just', 'really', 'simply', 'actually'), hedges ('could potentially', 'might possibly', 'I think', 'sort of'), and pleasantries. Drop decorative articles where they add no information ('parses flags' beats 'parses the flags'; keep articles when they carry grammatical work like 'a Rust CLI'). Each sentence does load-bearing work; cut redundant clauses.",
		full: "Terse caveman. Drop articles where it does not hurt meaning. Fragments OK. Pattern: \"[thing] [action] [reason]. [next step].\" Keep technical terms exact.",
		ultra: "Maximum English compression. Abbreviate common technical words. Use → for causality. One word when one word is enough. Preserve exact technical terms, identifiers, file paths.",
	};

	const conversationalDoNots = [
		"Do NOT write conversational openers (\"Let me…\", \"Here's…\", \"I'll…\", \"Now I'm going to…\", \"Sure, …\").",
		"Do NOT write trailing summaries, \"Want me to also…\" tails, or \"Hope this helps\".",
		"Do NOT add decorative section headers in chat replies.",
	];

	// Auto-clarity only makes sense for modes that actually shift register away
	// from normal English (full/ultra). lite is just tight professional prose, so
	// there is nothing to escape from.
	const autoClarityRule = mode === "lite"
		? undefined
		: "Auto-clarity rule: for security warnings, irreversible actions, or turns where the user is clearly confused, switch to normal clear prose for the affected portion of the reply, then resume caveman.";

	return [
		`You MUST respond in caveman ${mode} style for natural-language replies. This OVERRIDES default verbosity habits.`,
		modeText[mode],
		...conversationalDoNots,
		"Accuracy beats terseness when in conflict.",
		autoClarityRule,
		...boundaries,
		suffix,
	].filter(Boolean).join("\n");
}
