import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const INSTALL_SYMBOL = Symbol.for("vstack.pi-output-policy.installed");
const DEFAULT_SPILL_THRESHOLD_KB = 50;
const DEFAULT_INLINE_TAIL_KB = 20;
const DEFAULT_INLINE_TAIL_LINES = 500;
const DEFAULT_MAX_TEXT_BLOCK_KB = 50;
const DEFAULT_MAX_LINE_COUNT = 3000;
const DEFAULT_MAX_LINE_WIDTH = 2000;
const DEFAULT_MINIMIZER_MAX_CAPTURE_BYTES = 1024 * 1024;

type VstackConfig = Record<string, unknown>;
type Direction = "head" | "tail";

interface TruncationMeta {
	direction: Direction;
	truncated: boolean;
	reason: string;
	totalBytes: number;
	totalLines: number;
	shownBytes: number;
	shownLines: number;
	shownRange: string;
	artifactPath?: string;
	artifactError?: string;
	minimized?: boolean;
	minimizedDroppedLines?: number;
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
			const config = parsed?.vstack?.extensionManager?.config?.["pi-output-policy"];
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
	return typeof value === "string" ? value : fallback;
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes >= 10 * 1024 ? 0 : 1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)}MB`;
}

function truncateLine(line: string, maxWidth: number): string {
	if (line.length <= maxWidth) return line;
	return `${line.slice(0, Math.max(0, maxWidth - 1))}…`;
}

function boundedByBytes(lines: string[], maxBytes: number, direction: Direction): string[] {
	const out: string[] = [];
	let bytes = 0;
	const source = direction === "head" ? lines : [...lines].reverse();
	for (const line of source) {
		const lineBytes = byteLength(line) + 1;
		if (out.length > 0 && bytes + lineBytes > maxBytes) break;
		if (bytes + lineBytes > maxBytes && out.length === 0) {
			out.push(line.slice(0, Math.max(1, maxBytes - 1)));
			break;
		}
		out.push(line);
		bytes += lineBytes;
	}
	return direction === "head" ? out : out.reverse();
}

function truncateText(text: string, direction: Direction, maxBytes: number, maxLines: number, maxLineWidth: number): { content: string; meta: Omit<TruncationMeta, "artifactPath" | "artifactError" | "reason" | "truncated"> } {
	const rawLines = text.split(/\r?\n/);
	const widthSafe = rawLines.map((line) => truncateLine(line, maxLineWidth));
	const lineLimited = direction === "head" ? widthSafe.slice(0, maxLines) : widthSafe.slice(-maxLines);
	const byteLimited = boundedByBytes(lineLimited, maxBytes, direction);
	const shownStart = direction === "head" ? 1 : Math.max(1, rawLines.length - byteLimited.length + 1);
	const shownEnd = direction === "head" ? byteLimited.length : rawLines.length;
	const content = byteLimited.join("\n");
	return {
		content,
		meta: {
			direction,
			totalBytes: byteLength(text),
			totalLines: rawLines.length,
			shownBytes: byteLength(content),
			shownLines: byteLimited.length,
			shownRange: `lines ${shownStart}-${shownEnd}`,
		},
	};
}

function directionForTool(toolName: string): Direction {
	const name = toolName.toLowerCase();
	if (["bash", "python", "bg_task", "bg_status"].some((prefix) => name.includes(prefix))) return "tail";
	return "head";
}

function commandFamily(command: string): string {
	const trimmed = command.trim();
	const first = trimmed.split(/\s+/)[0] ?? "";
	return basename(first).toLowerCase();
}

function listSetting(key: string, cwd?: string): string[] {
	return settingString(key, "", cwd)
		.split(",")
		.map((part) => part.trim().toLowerCase())
		.filter(Boolean);
}

function shouldMinimize(command: string, cwd?: string): boolean {
	if (!settingBoolean("shellMinimizer.enabled", true, cwd)) return false;
	const family = commandFamily(command);
	const defaults = ["git", "npm", "pnpm", "yarn", "bun", "cargo", "pytest", "go", "mvn", "gradle"];
	const only = listSetting("shellMinimizer.only", cwd);
	const except = listSetting("shellMinimizer.except", cwd);
	if (except.includes(family)) return false;
	return only.length > 0 ? only.includes(family) : defaults.includes(family);
}

function minimizeShellOutput(text: string, command: string, cwd?: string): { text: string; dropped: number } {
	if (!shouldMinimize(command, cwd)) return { dropped: 0, text };
	if (byteLength(text) > settingNumber("shellMinimizer.maxCaptureBytes", DEFAULT_MINIMIZER_MAX_CAPTURE_BYTES, cwd)) {
		return { dropped: 0, text };
	}
	const lines = text.split(/\r?\n/);
	const keep = new Set<number>();
	const important = /(error|failed|failure|panic|warning|warn|exception|traceback|summary|finished|test result|\bpass(ed)?\b|\bfail(ed)?\b|\bok\b|exit code|aborted|denied)/i;
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i] ?? "";
		if (i < 20 || i >= lines.length - 80 || important.test(line)) keep.add(i);
	}
	const compact: string[] = [];
	let dropped = 0;
	let gap = 0;
	for (let i = 0; i < lines.length; i += 1) {
		if (keep.has(i)) {
			if (gap > 0) compact.push(`[...${gap} repetitive/noisy line(s) minimized...]`);
			gap = 0;
			compact.push(lines[i] ?? "");
		} else {
			dropped += 1;
			gap += 1;
		}
	}
	if (gap > 0) compact.push(`[...${gap} repetitive/noisy line(s) minimized...]`);
	return dropped > 0 ? { dropped, text: compact.join("\n") } : { dropped: 0, text };
}

function writeArtifact(ctx: ExtensionContext, toolName: string, toolCallId: string | undefined, text: string): { path?: string; error?: string } {
	if (!settingBoolean("preserveFullOutput", true, ctx.cwd)) return {};
	const safeTool = toolName.replaceAll(/[^a-z0-9_.-]+/gi, "-").slice(0, 40) || "tool";
	const safeId = (toolCallId ?? Date.now().toString(36)).replaceAll(/[^a-z0-9_.-]+/gi, "-").slice(0, 80);
	const candidates = [join(ctx.cwd, ".pi", "artifacts", "output-policy"), join(tmpdir(), "pi-output-policy")];
	for (const dir of candidates) {
		try {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			const artifactPath = join(dir, `${Date.now()}-${safeTool}-${safeId}.txt`);
			writeFileSync(artifactPath, text, "utf8");
			return { path: artifactPath };
		} catch (error) {
			if (dir === candidates[candidates.length - 1]) return { error: stringifyError(error) };
		}
	}
	return { error: "artifact persistence unavailable" };
}

function notice(meta: TruncationMeta): string {
	const target = meta.direction === "tail" ? `Showing last ${meta.shownLines} lines / ${formatSize(meta.shownBytes)}` : `Showing ${meta.shownRange} of ${meta.totalLines} / ${formatSize(meta.shownBytes)}`;
	const artifact = meta.artifactPath ? ` Full output: ${meta.artifactPath}` : meta.artifactError ? ` Full output preservation unavailable: ${meta.artifactError}` : "";
	const minimized = meta.minimized ? ` Minimized ${meta.minimizedDroppedLines} noisy line(s) before truncation.` : "";
	return `[Output truncated (${meta.direction}). ${target}. Total: ${meta.totalLines} lines / ${formatSize(meta.totalBytes)}.${minimized}${artifact}]`;
}

function processText(event: any, ctx: ExtensionContext, text: string): { text: string; meta?: TruncationMeta } {
	const cwd = ctx.cwd;
	const direction = directionForTool(event.toolName ?? "tool");
	const maxLineWidth = Math.max(80, Math.floor(settingNumber("maxLineWidth", DEFAULT_MAX_LINE_WIDTH, cwd)));
	const maxLineCount = Math.max(1, Math.floor(settingNumber("maxLineCount", DEFAULT_MAX_LINE_COUNT, cwd)));
	const spillThresholdBytes = Math.max(1, Math.floor(settingNumber("spillThresholdKb", DEFAULT_SPILL_THRESHOLD_KB, cwd) * 1024));
	const maxTextBytes = Math.max(1, Math.floor(settingNumber("maxTextBlockKb", DEFAULT_MAX_TEXT_BLOCK_KB, cwd) * 1024));
	const inlineTailBytes = Math.max(1, Math.floor(settingNumber("inlineTailKb", DEFAULT_INLINE_TAIL_KB, cwd) * 1024));
	const inlineTailLines = Math.max(1, Math.floor(settingNumber("inlineTailLines", DEFAULT_INLINE_TAIL_LINES, cwd)));

	const original = text;
	let working = text;
	let minimized = false;
	let minimizedDroppedLines = 0;
	if ((event.toolName ?? "").toLowerCase() === "bash" && typeof event.input?.command === "string") {
		const result = minimizeShellOutput(working, event.input.command, cwd);
		working = result.text;
		minimized = result.dropped > 0;
		minimizedDroppedLines = result.dropped;
	}

	const lines = working.split(/\r?\n/);
	const tooLarge = byteLength(working) > spillThresholdBytes || lines.length > maxLineCount || lines.some((line) => line.length > maxLineWidth);
	if (!tooLarge) {
		const widthSafe = lines.map((line) => truncateLine(line, maxLineWidth)).join("\n");
		return minimized ? { text: `${widthSafe}\n\n[Output minimized: removed ${minimizedDroppedLines} repetitive/noisy line(s).]` } : { text: widthSafe };
	}

	const artifact = writeArtifact(ctx, event.toolName ?? "tool", event.toolCallId, original);
	const bytes = direction === "tail" ? inlineTailBytes : maxTextBytes;
	const lineLimit = direction === "tail" ? inlineTailLines : maxLineCount;
	const truncated = truncateText(working, direction, bytes, lineLimit, maxLineWidth);
	const meta: TruncationMeta = {
		...truncated.meta,
		artifactError: artifact.error,
		artifactPath: artifact.path,
		direction,
		minimized,
		minimizedDroppedLines,
		reason: byteLength(working) > spillThresholdBytes ? "spill-threshold" : "ui-safety",
		truncated: true,
	};
	return { meta, text: `${truncated.content}\n\n${notice(meta)}` };
}

function sanitizeDetails(value: unknown, depth = 0): { value: unknown; changed: boolean } {
	if (depth > 4) return { changed: true, value: "[Max detail depth reached]" };
	if (value == null || typeof value === "number" || typeof value === "boolean") return { changed: false, value };
	if (typeof value === "string") {
		const max = 8 * 1024;
		return value.length > max ? { changed: true, value: `${value.slice(0, max)}… [detail string truncated]` } : { changed: false, value };
	}
	if (Array.isArray(value)) {
		let changed = value.length > 50;
		const sanitized = value.slice(0, 50).map((item) => {
			const nested = sanitizeDetails(item, depth + 1);
			changed ||= nested.changed;
			return nested.value;
		});
		return { changed, value: sanitized };
	}
	if (typeof value === "object") {
		let changed = false;
		const out: Record<string, unknown> = {};
		for (const [index, [key, nested]] of Object.entries(value as Record<string, unknown>).entries()) {
			if (index >= 80) {
				out["[truncated]"] = "detail object field cap reached";
				changed = true;
				break;
			}
			const sanitized = sanitizeDetails(nested, depth + 1);
			changed ||= sanitized.changed;
			out[key] = sanitized.value;
		}
		return { changed, value: out };
	}
	return { changed: true, value: String(value) };
}

function stringifyError(error: unknown): string {
	if (error instanceof Error) return `${error.name}: ${error.message}`;
	return String(error);
}

export default function outputPolicy(pi: ExtensionAPI): void {
	const guard = pi as unknown as Record<PropertyKey, unknown>;
	if (guard[INSTALL_SYMBOL]) return;
	guard[INSTALL_SYMBOL] = true;

	pi.on("tool_result", async (event: any, ctx: ExtensionContext) => {
		if (!settingBoolean("enabled", true, ctx.cwd)) return undefined;
		let changed = false;
		const metas: TruncationMeta[] = [];
		const content = (event.content ?? []).map((part: any) => {
			if (!part || part.type !== "text" || typeof part.text !== "string") return part;
			const processed = processText(event, ctx, part.text);
			if (processed.text !== part.text) changed = true;
			if (processed.meta) metas.push(processed.meta);
			return { ...part, text: processed.text };
		});
		const sanitizedDetails = sanitizeDetails(event.details);
		let details = sanitizedDetails.value;
		if (metas.length > 0) {
			details = details && typeof details === "object" && !Array.isArray(details) ? { ...(details as Record<string, unknown>) } : {};
			(details as Record<string, unknown>).vstackOutputPolicy = metas;
			changed = true;
		}
		if (sanitizedDetails.changed) changed = true;
		return changed ? { content, details } : undefined;
	});
}
