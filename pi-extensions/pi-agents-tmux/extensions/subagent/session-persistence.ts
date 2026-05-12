import * as fs from "node:fs";

const SESSION_TAIL_BYTES = 1024 * 1024;

export interface SessionLeafContextLike {
	sessionManager: {
		getLeafId?: () => string | null | undefined;
		getSessionFile?: () => string | undefined;
	};
}

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableValue);
	if (!value || typeof value !== "object") return value;
	const sorted: Record<string, unknown> = {};
	for (const key of Object.keys(value as Record<string, unknown>).sort()) sorted[key] = stableValue((value as Record<string, unknown>)[key]);
	return sorted;
}

export function stableSessionSnapshotFingerprint(value: unknown): string {
	return JSON.stringify(stableValue(value));
}

function lastEntryIdFromText(text: string): string | undefined {
	const lines = text.split(/\r?\n/);
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]?.trim();
		if (!line) continue;
		try {
			const entry = JSON.parse(line) as { id?: unknown; type?: unknown };
			if (entry.type !== "session" && typeof entry.id === "string" && entry.id.trim()) return entry.id;
		} catch {
			// Tail chunks can start mid-line; keep scanning earlier lines or fall back to full read.
		}
	}
	return undefined;
}

export async function readLastSessionEntryId(sessionFile: string): Promise<string | undefined> {
	const handle = await fs.promises.open(sessionFile, "r");
	try {
		const stat = await handle.stat();
		if (stat.size <= 0) return undefined;
		const length = Math.min(stat.size, SESSION_TAIL_BYTES);
		const start = stat.size - length;
		const buffer = Buffer.alloc(length);
		await handle.read(buffer, 0, length, start);
		const fromTail = lastEntryIdFromText(buffer.toString("utf8"));
		if (fromTail || start === 0) return fromTail;
	} finally {
		await handle.close();
	}

	// Rare fallback: last JSONL entry is larger than the tail window.
	return lastEntryIdFromText(await fs.promises.readFile(sessionFile, "utf8"));
}

export async function sessionFileTailMatchesLeaf(ctx: SessionLeafContextLike): Promise<boolean> {
	const sessionFile = ctx.sessionManager.getSessionFile?.();
	if (!sessionFile) return true;
	let leafId: string | null | undefined;
	try {
		leafId = ctx.sessionManager.getLeafId?.();
	} catch {
		return false;
	}
	let lastId: string | undefined;
	try {
		lastId = await readLastSessionEntryId(sessionFile);
	} catch {
		return false;
	}
	if (!leafId) return lastId === undefined;
	return lastId === leafId;
}
