import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { canonicalPath } from "./paths.js";
import { configuredSessionDir, settingBoolean } from "./settings.js";
import { LEGACY_STATUS_KEY, VSTACK_MODAL_LOCK_SYMBOL, type Scope, type SessionInfo, type VstackModalLock } from "./types.js";

function appendSessionInfoFallback(sessionPath: string, name: string): void {
	const ids = new Set<string>();
	let parentId: string | null = null;
	try {
		const lines = readFileSync(sessionPath, "utf8").split(/\r?\n/);
		for (const line of lines) {
			if (!line.trim()) continue;
			const entry = JSON.parse(line) as { type?: string; id?: string };
			if (entry.type === "session") continue;
			if (typeof entry.id === "string") {
				ids.add(entry.id);
				parentId = entry.id;
			}
		}
	} catch {
		// If parsing fails, still append a valid standalone session_info entry.
	}

	let id = randomUUID().slice(0, 8);
	while (ids.has(id)) id = randomUUID().slice(0, 8);
	appendFileSync(sessionPath, `${JSON.stringify({ type: "session_info", id, parentId, timestamp: new Date().toISOString(), name: name.trim() })}\n`);
}

export function renameSession(path: string, name: string): void {
	try {
		SessionManager.open(path).appendSessionInfo(name);
	} catch {
		appendSessionInfoFallback(path, name);
	}
}

export async function deleteSessionFile(sessionPath: string, cwd: string): Promise<{ ok: boolean; method: "trash" | "unlink"; error?: string }> {
	if (settingBoolean("deleteUsesTrash", true, cwd)) {
		const trashArgs = sessionPath.startsWith("-") ? ["--", sessionPath] : [sessionPath];
		const trashResult = spawnSync("trash", trashArgs, { encoding: "utf8" });
		if (trashResult.status === 0 || !existsSync(sessionPath)) return { ok: true, method: "trash" };
	}

	try {
		await unlink(sessionPath);
		return { ok: true, method: "unlink" };
	} catch (error) {
		return { ok: false, method: "unlink", error: error instanceof Error ? error.message : String(error) };
	}
}

export async function loadSessionsForScope(cwd: string, scope: Scope, onProgress?: (loaded: number, total: number) => void): Promise<SessionInfo[]> {
	const customSessionDir = configuredSessionDir(cwd);
	if (customSessionDir) {
		const sessions = await SessionManager.list(cwd, customSessionDir, onProgress);
		if (scope === "all") return sessions;
		const current = canonicalPath(cwd);
		return sessions.filter((session) => canonicalPath(session.cwd) === current);
	}
	return scope === "all" ? SessionManager.listAll(onProgress) : SessionManager.list(cwd, undefined, onProgress);
}

export function clearLegacySessionStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(LEGACY_STATUS_KEY, undefined);
}

export function acquireVstackModalLock(): () => void {
	const host = globalThis as unknown as Record<PropertyKey, unknown>;
	const existing = host[VSTACK_MODAL_LOCK_SYMBOL] as VstackModalLock | undefined;
	const lock = existing && typeof existing.depth === "number" ? existing : { depth: 0 };
	host[VSTACK_MODAL_LOCK_SYMBOL] = lock;
	lock.depth += 1;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		lock.depth = Math.max(0, lock.depth - 1);
	};
}
