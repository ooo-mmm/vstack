import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionInstallScope } from "./types.js";

export function expandHome(input: string): string {
	if (input === "~") return homedir();
	if (input.startsWith("~/")) return join(homedir(), input.slice(2));
	return input;
}

export function userPiDir(): string {
	return resolve(expandHome(process.env.PI_CODING_AGENT_DIR?.trim() || "~/.pi/agent"));
}

export function findProjectPiDir(cwd: string): string {
	let current = resolve(cwd);
	while (true) {
		const candidate = join(current, ".pi");
		if (existsSync(candidate)) return candidate;
		if (existsSync(join(current, ".git")) || existsSync(join(current, ".vstack-lock.json"))) return candidate;
		const parent = dirname(current);
		if (parent === current) return join(resolve(cwd), ".pi");
		current = parent;
	}
}

export function projectSettingsPath(cwd: string): string {
	return join(findProjectPiDir(cwd), "settings.json");
}

function normalizeDir(path: string): string {
	const normalized = resolve(path);
	return normalized.endsWith(sep) ? normalized : normalized + sep;
}

function isWithin(path: string, parent: string): boolean {
	return normalizeDir(path).startsWith(normalizeDir(parent));
}

export function detectExtensionInstallScope(cwd: string): ExtensionInstallScope {
	try {
		const extensionFile = fileURLToPath(import.meta.url);
		if (isWithin(extensionFile, findProjectPiDir(cwd))) return "project";
		if (isWithin(extensionFile, getAgentDir())) return "global";
	} catch {
		// Fall through to global for unusual loaders.
	}
	return "global";
}
