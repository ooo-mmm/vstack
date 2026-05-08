import {
	DEFAULT_LOG_TAIL_MAX_CHARS,
	DEFAULT_OUTPUT_ALERT_MAX_CHARS,
	DEFAULT_OUTPUT_BUFFER_MAX_CHARS,
} from "./constants.js";
import { settingNumber } from "./settings.js";
import type { BackgroundLogTruncation, BackgroundTaskSnapshot, BackgroundTaskStatus } from "./types.js";

export function tailText(text: string, maxChars: number = settingNumber("outputAlertMaxChars", DEFAULT_OUTPUT_ALERT_MAX_CHARS)): string {
	if (text.length <= maxChars) return text;
	return `[...truncated]\n${text.slice(-maxChars)}`;
}

export function taskLogTruncation(output: string, logFile: string, cwd?: string): BackgroundLogTruncation | undefined {
	const maxChars = Math.max(1, Math.floor(settingNumber("logTailMaxChars", DEFAULT_LOG_TAIL_MAX_CHARS, cwd)));
	if (output.length <= maxChars) return undefined;
	return { direction: "tail", fullOutputPath: logFile, shownChars: maxChars, totalChars: output.length, truncated: true };
}

export function formatTaskLog(output: string, logFile: string, cwd?: string): string {
	if (!output) return "(empty)";
	const truncation = taskLogTruncation(output, logFile, cwd);
	if (!truncation) return output;
	return `[...truncated]\n${output.slice(-truncation.shownChars)}\n\n[Background log truncated. Showing last ${truncation.shownChars} of ${truncation.totalChars} character(s). Full log: ${logFile}]`;
}

export function trimOutputBuffer(output: string, lastAnnouncedLength: number): { output: string; lastAnnouncedLength: number } {
	const maxChars = settingNumber("outputBufferMaxChars", DEFAULT_OUTPUT_BUFFER_MAX_CHARS);
	if (output.length <= maxChars) return { output, lastAnnouncedLength };
	const overflow = output.length - maxChars;
	return {
		lastAnnouncedLength: Math.max(0, lastAnnouncedLength - overflow),
		output: output.slice(-maxChars),
	};
}

export function formatDuration(ms: number): string {
	const safe = Math.max(0, ms);
	if (safe < 1_000) return `${safe}ms`;
	const seconds = safe / 1_000;
	if (seconds < 60) return `${seconds.toFixed(seconds >= 10 ? 0 : 1)}s`;
	const minutes = Math.floor(seconds / 60);
	const remSeconds = Math.floor(seconds % 60);
	if (minutes < 60) return remSeconds > 0 ? `${minutes}m ${remSeconds}s` : `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const remMinutes = minutes % 60;
	return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

export function formatRelativeTime(timestamp: number, now: number = Date.now()): string {
	const diff = timestamp - now;
	const abs = Math.abs(diff);
	const suffix = diff >= 0 ? "from now" : "ago";
	if (abs < 1_000) return diff >= 0 ? "now" : "just now";
	if (abs < 60_000) return `${Math.floor(abs / 1_000)}s ${suffix}`;
	if (abs < 3_600_000) return `${Math.floor(abs / 60_000)}m ${suffix}`;
	if (abs < 86_400_000) return `${Math.floor(abs / 3_600_000)}h ${suffix}`;
	return `${Math.floor(abs / 86_400_000)}d ${suffix}`;
}

export function parseOutputMatcher(pattern: string | undefined): ((text: string) => boolean) | null {
	const needle = pattern?.trim();
	if (!needle) return null;

	const regexMatch = needle.match(/^\/(.*)\/([gimsuy]*)$/);
	if (regexMatch) {
		try {
			const regex = new RegExp(regexMatch[1], regexMatch[2]);
			return (text: string) => {
				regex.lastIndex = 0;
				return regex.test(text);
			};
		} catch {
			// Invalid regex falls through to substring matching.
		}
	}

	const lower = needle.toLowerCase();
	return (text: string) => text.toLowerCase().includes(lower);
}

export function summarizeTaskStatus(status: BackgroundTaskStatus, exitCode: number | null): string {
	switch (status) {
		case "running":
			return "running";
		case "completed":
			return `completed (exit ${exitCode ?? 0})`;
		case "failed":
			return `failed (exit ${exitCode ?? "?"})`;
		case "timed_out":
			return exitCode === null ? "timed out" : `timed out (exit ${exitCode})`;
		case "stopped":
			return exitCode === null ? "stopped" : `stopped (exit ${exitCode})`;
	}
}

export function taskDisplayName(task: Pick<BackgroundTaskSnapshot, "title" | "command">): string {
	return task.title.trim() || task.command.trim();
}

export function buildTaskSummaryLine(task: BackgroundTaskSnapshot, now: number = Date.now()): string {
	const activityAt = task.lastOutputAt ?? task.updatedAt;
	return `${task.id} · ${summarizeTaskStatus(task.status, task.exitCode)} · pid ${task.pid} · ${taskDisplayName(
		task,
	)} · ${formatRelativeTime(activityAt, now)}`;
}

export function taskActivityAt(task: Pick<BackgroundTaskSnapshot, "lastOutputAt" | "updatedAt">): number {
	return task.lastOutputAt ?? task.updatedAt;
}

export function taskElapsedMs(task: Pick<BackgroundTaskSnapshot, "startedAt" | "status" | "updatedAt">, now: number = Date.now()): number {
	return (task.status === "running" ? now : task.updatedAt) - task.startedAt;
}

export function compactText(value: string, maxChars = 80): string {
	const compact = value.replace(/\s+/g, " ").trim();
	return compact.length > maxChars ? `${compact.slice(0, Math.max(0, maxChars - 1))}…` : compact;
}

export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function normalizedCommand(command: string): string {
	return command.replace(/\s+/g, " ").trim();
}

export function formatShortcutHint(shortcut: string): string {
	return shortcut
		.split("+")
		.map((part) => (part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()))
		.join("+");
}

export function lineCount(text: string): number {
	if (!text) return 0;
	return text.split(/\r?\n/).length;
}

export function takeTailLines(text: string, maxLines: number): { hidden: number; lines: string[]; total: number } {
	const lines = text.trimEnd().length > 0 ? text.trimEnd().split(/\r?\n/) : [];
	const limit = Math.max(1, Math.floor(maxLines));
	return { hidden: Math.max(0, lines.length - limit), lines: lines.slice(-limit), total: lines.length };
}
