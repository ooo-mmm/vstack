/*
 * vstack Pi background tasks.
 *
 * Locally owned package based on ideas and portions of the MIT-licensed
 * @ifi/pi-background-tasks package. See ../THIRD_PARTY_NOTICES.md.
 */

import { StringEnum } from "@mariozechner/pi-ai";
import {
	getShellConfig,
	type AgentToolResult,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type Theme,
} from "@mariozechner/pi-coding-agent";
import { matchesKey, Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const BG_COMMAND = "bg";
const DEFAULT_BG_SHORTCUT = "ctrl+shift+b";
const BG_MESSAGE_TYPE = "vstack-background-tasks:event";
const BG_WIDGET_KEY = "vstack-background-tasks";
const BG_INSTALL_SYMBOL = Symbol.for("vstack.background-tasks.installed");

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_OUTPUT_SETTLE_MS = 1_500;
const DEFAULT_FORCE_KILL_GRACE_MS = 5_000;
const DEFAULT_OUTPUT_BUFFER_MAX_CHARS = 120_000;
const DEFAULT_OUTPUT_ALERT_MAX_CHARS = 3_000;
const DEFAULT_LOG_TAIL_MAX_CHARS = 5_000;
const DASHBOARD_WIDTH = 96;
const DASHBOARD_MAX_HEIGHT = "80%";
const DASHBOARD_TASK_ROWS = 12;
const DASHBOARD_OUTPUT_ROWS = 16;
const TASK_PANE_MIN_WIDTH = 30;
const TASK_PANE_MAX_WIDTH = 42;

type BackgroundTaskStatus = "running" | "completed" | "failed" | "stopped" | "timed_out";
type TaskEventType = "output" | "exit";

type ManagedTask = BackgroundTaskSnapshot & {
	child: ChildProcess;
	closed: boolean;
	forceKillTimer: ReturnType<typeof setTimeout> | null;
	lastAnnouncedLength: number;
	matcher: ((text: string) => boolean) | null;
	notifyOnExit: boolean;
	notifyOnOutput: boolean;
	output: string;
	outputTimer: ReturnType<typeof setTimeout> | null;
	stopReason: "user" | "timeout" | "shutdown" | null;
	timeoutTimer: ReturnType<typeof setTimeout> | null;
};

interface BackgroundTaskSnapshot {
	id: string;
	title: string;
	command: string;
	cwd: string;
	pid: number;
	logFile: string;
	startedAt: number;
	updatedAt: number;
	lastOutputAt: number | null;
	expiresAt: number | null;
	status: BackgroundTaskStatus;
	exitCode: number | null;
	notifyOnExit: boolean;
	notifyOnOutput: boolean;
	notifyPattern?: string;
	outputBytes: number;
}

interface BackgroundTaskEventDetails {
	eventAt: number;
	eventType: TaskEventType;
	matchedPattern?: string;
	newOutputTail?: string;
	outputTail: string;
	task: BackgroundTaskSnapshot;
}

interface SpawnTaskOptions {
	command: string;
	cwd?: string;
	notifyOnExit?: boolean;
	notifyOnOutput?: boolean;
	notifyPattern?: string;
	timeoutSeconds?: number;
	title?: string;
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
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
			const config = parsed?.vstack?.extensionManager?.config?.["pi-background-tasks"];
			if (config && typeof config === "object" && !Array.isArray(config)) Object.assign(merged, config);
		} catch {
			// Ignore malformed optional manager config; keep safe defaults.
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

function taskDir(): string {
	const configured = settingString("taskDir", "");
	return process.env.PI_BG_TASK_DIR?.trim() || (configured ? resolve(expandHome(configured)) : join(tmpdir(), "vstack-pi-bg"));
}

function safeLabel(input: string): string {
	return input.replaceAll(/[^a-z0-9-]+/gi, "-").replaceAll(/^-+|-+$/g, "").slice(0, 48) || "task";
}

function logFilePath(id: string, now: number = Date.now()): string {
	const dir = taskDir();
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return join(dir, `${safeLabel(id)}-${now}.log`);
}

function tailText(text: string, maxChars: number = settingNumber("outputAlertMaxChars", DEFAULT_OUTPUT_ALERT_MAX_CHARS)): string {
	if (text.length <= maxChars) return text;
	return `[...truncated]\n${text.slice(-maxChars)}`;
}

function trimOutputBuffer(output: string, lastAnnouncedLength: number): { output: string; lastAnnouncedLength: number } {
	const maxChars = settingNumber("outputBufferMaxChars", DEFAULT_OUTPUT_BUFFER_MAX_CHARS);
	if (output.length <= maxChars) return { output, lastAnnouncedLength };
	const overflow = output.length - maxChars;
	return {
		lastAnnouncedLength: Math.max(0, lastAnnouncedLength - overflow),
		output: output.slice(-maxChars),
	};
}

function formatDuration(ms: number): string {
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

function formatRelativeTime(timestamp: number, now: number = Date.now()): string {
	const diff = timestamp - now;
	const abs = Math.abs(diff);
	const suffix = diff >= 0 ? "from now" : "ago";
	if (abs < 1_000) return diff >= 0 ? "now" : "just now";
	if (abs < 60_000) return `${Math.floor(abs / 1_000)}s ${suffix}`;
	if (abs < 3_600_000) return `${Math.floor(abs / 60_000)}m ${suffix}`;
	if (abs < 86_400_000) return `${Math.floor(abs / 3_600_000)}h ${suffix}`;
	return `${Math.floor(abs / 86_400_000)}d ${suffix}`;
}

function parseOutputMatcher(pattern: string | undefined): ((text: string) => boolean) | null {
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

function summarizeTaskStatus(status: BackgroundTaskStatus, exitCode: number | null): string {
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

function taskDisplayName(task: Pick<BackgroundTaskSnapshot, "title" | "command">): string {
	return task.title.trim() || task.command.trim();
}

function buildTaskSummaryLine(task: BackgroundTaskSnapshot, now: number = Date.now()): string {
	const activityAt = task.lastOutputAt ?? task.updatedAt;
	return `${task.id} · ${summarizeTaskStatus(task.status, task.exitCode)} · pid ${task.pid} · ${taskDisplayName(
		task,
	)} · ${formatRelativeTime(activityAt, now)}`;
}

function taskSnapshot(task: ManagedTask): BackgroundTaskSnapshot {
	return {
		command: task.command,
		cwd: task.cwd,
		exitCode: task.exitCode,
		expiresAt: task.expiresAt,
		id: task.id,
		lastOutputAt: task.lastOutputAt,
		logFile: task.logFile,
		notifyOnExit: task.notifyOnExit,
		notifyOnOutput: task.notifyOnOutput,
		notifyPattern: task.notifyPattern,
		outputBytes: task.outputBytes,
		pid: task.pid,
		startedAt: task.startedAt,
		status: task.status,
		title: task.title,
		updatedAt: task.updatedAt,
	};
}

function resolveTaskByToken<T extends Pick<BackgroundTaskSnapshot, "id" | "pid">>(
	tasks: Iterable<T>,
	token: string | number | undefined,
): T | null {
	if (token === undefined || token === null || token === "") return null;
	const normalized = String(token).trim();
	if (!normalized) return null;
	for (const task of tasks) {
		if (task.id === normalized || String(task.pid) === normalized) return task;
	}
	return null;
}

function padAnsi(text: string, width: number): string {
	const truncated = truncateToWidth(text, width, "");
	return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

function splitOutputLines(output: string): string[] {
	const text = tailText(output, settingNumber("logTailMaxChars", DEFAULT_LOG_TAIL_MAX_CHARS)).trimEnd();
	return text.length > 0 ? text.split(/\r?\n/) : ["(no output yet)"];
}

function makeToolResult(text: string, details: Record<string, unknown> = {}): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details };
}

function renderBackgroundMessage(text: string, theme: Theme): Text {
	return new Text(text, 1, 0, (segment: string) => theme.bg("customMessageBg", segment));
}

function isBackgroundTaskEventDetails(value: unknown): value is BackgroundTaskEventDetails {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<BackgroundTaskEventDetails>;
	return (
		(candidate.eventType === "output" || candidate.eventType === "exit") &&
		Boolean(candidate.task) &&
		typeof candidate.outputTail === "string"
	);
}

function renderTaskEventMessage(
	message: { content?: unknown; details?: unknown },
	expanded: boolean,
	theme: Theme,
): Text {
	if (!isBackgroundTaskEventDetails(message.details)) {
		return renderBackgroundMessage(String(message.content ?? "Background task update"), theme);
	}

	const details = message.details;
	const heading =
		details.eventType === "exit"
			? theme.fg("success", theme.bold("⚙ Background task finished"))
			: theme.fg("accent", theme.bold("⚙ Background task output"));
	const lines = [
		heading,
		`${theme.fg("muted", "Task")}: ${details.task.id} · ${taskDisplayName(details.task)}`,
		`${theme.fg("muted", "Status")}: ${summarizeTaskStatus(details.task.status, details.task.exitCode)} · pid ${
			details.task.pid
		}`,
		`${theme.fg("muted", "Started")}: ${formatRelativeTime(details.task.startedAt, details.eventAt)} · ${formatDuration(
			details.eventAt - details.task.startedAt,
		)} elapsed`,
		`${theme.fg("muted", "Command")}: ${details.task.command}`,
		`${theme.fg("muted", "Log")}: ${details.task.logFile}`,
	];

	if (details.task.expiresAt != null) {
		lines.push(
			`${theme.fg("muted", "Expiry")}: ${formatRelativeTime(details.task.expiresAt, details.eventAt)} (${formatDuration(
				details.task.expiresAt - details.eventAt,
			)} remaining)`,
		);
	}
	if (details.matchedPattern) lines.push(`${theme.fg("muted", "Pattern")}: ${details.matchedPattern}`);

	const preview = details.eventType === "output" ? details.newOutputTail || details.outputTail : details.outputTail;
	const outputLines = preview.trim().length > 0 ? preview.split(/\r?\n/) : ["(no output yet)"];
	lines.push("", theme.fg("accent", theme.bold("Recent output")));
	lines.push(...(expanded ? outputLines : outputLines.slice(-8)));
	if (!expanded && outputLines.length > 8) lines.push(theme.fg("dim", "Expand to inspect more output."));
	return renderBackgroundMessage(lines.join("\n"), theme);
}

export default function backgroundTasks(pi: ExtensionAPI): void {
	const guard = pi as unknown as Record<PropertyKey, unknown>;
	if (guard[BG_INSTALL_SYMBOL]) return;
	guard[BG_INSTALL_SYMBOL] = true;
	if (!settingBoolean("enabled", true)) return;

	let activeCtx: ExtensionContext | null = null;
	let requestWidgetRender: (() => void) | null = null;
	const dashboardShortcut = settingString("dashboardShortcut", DEFAULT_BG_SHORTCUT);
	let taskCounter = 0;
	let shuttingDown = false;
	const tasks = new Map<string, ManagedTask>();

	const sortedTasks = (): ManagedTask[] => [...tasks.values()].sort((a, b) => b.startedAt - a.startedAt);

	const getTaskOutput = (task: ManagedTask): string => {
		if (task.output.length > 0) return task.output;
		if (!existsSync(task.logFile)) return "";
		try {
			return readFileSync(task.logFile, "utf8");
		} catch {
			return "";
		}
	};

	const clearTaskTimers = (task: ManagedTask) => {
		if (task.outputTimer) clearTimeout(task.outputTimer);
		if (task.timeoutTimer) clearTimeout(task.timeoutTimer);
		if (task.forceKillTimer) clearTimeout(task.forceKillTimer);
		task.outputTimer = null;
		task.timeoutTimer = null;
		task.forceKillTimer = null;
	};

	const clearWidget = () => {
		activeCtx?.ui.setWidget(BG_WIDGET_KEY, undefined);
		requestWidgetRender = null;
	};

	const renderWidgetLines = (theme: Theme): string[] => {
		const sorted = sortedTasks();
		const running = sorted.filter((task) => task.status === "running");
		const latest = sorted[0];
		const finished = sorted.length - running.length;
		const summary = `${theme.fg("accent", theme.bold("⚙ Background tasks"))} ${theme.fg(
			"muted",
			`${running.length} running · ${finished} finished`,
		)}`;
		if (!latest) return [summary];
		const activityAt = latest.lastOutputAt ?? latest.updatedAt;
		return [
			summary,
			`${theme.fg("dim", `${latest.id} · ${taskDisplayName(latest)} · ${formatRelativeTime(activityAt)}`)} · ${theme.fg(
				"muted",
				`${dashboardShortcut} dashboard`,
			)}`,
		];
	};

	const syncWidget = (ctx: ExtensionContext) => {
		activeCtx = ctx;
		if (tasks.size === 0 || !ctx.hasUI || !settingBoolean("showWidget", true, ctx.cwd)) {
			clearWidget();
			return;
		}

		ctx.ui.setWidget(
			BG_WIDGET_KEY,
			(tui, theme) => {
				requestWidgetRender = () => tui.requestRender();
				let timer: ReturnType<typeof setInterval> | null = null;

				const ensureTimer = () => {
					const hasRunning = sortedTasks().some((task) => task.status === "running");
					if (!hasRunning) {
						if (timer) clearInterval(timer);
						timer = null;
						return;
					}
					if (timer) return;
					timer = setInterval(() => tui.requestRender(), 1_000);
					timer.unref?.();
				};

				return {
					dispose() {
						if (timer) clearInterval(timer);
						if (requestWidgetRender) requestWidgetRender = null;
					},
					invalidate() {},
					render(width: number) {
						ensureTimer();
						return renderWidgetLines(theme).map((line) => truncateToWidth(line, width, ""));
					},
				};
			},
			{ placement: settingString("widgetPlacement", "belowEditor", ctx.cwd) === "aboveEditor" ? "aboveEditor" : "belowEditor" },
		);
	};

	const refreshUi = () => {
		if (activeCtx) syncWidget(activeCtx);
		requestWidgetRender?.();
	};

	const sendTaskEvent = (
		eventType: TaskEventType,
		task: ManagedTask,
		options: { matchedPattern?: string; newOutputTail?: string } = {},
	) => {
		if (shuttingDown) return;
		if (eventType === "output" && !task.notifyOnOutput) return;
		if (eventType === "exit" && !task.notifyOnExit) return;

		const details: BackgroundTaskEventDetails = {
			eventAt: Date.now(),
			eventType,
			matchedPattern: options.matchedPattern,
			newOutputTail: options.newOutputTail,
			outputTail: tailText(getTaskOutput(task), settingNumber("outputAlertMaxChars", DEFAULT_OUTPUT_ALERT_MAX_CHARS, activeCtx?.cwd)),
			task: taskSnapshot(task),
		};
		const headline =
			eventType === "exit"
				? `Background task ${task.id} finished (${summarizeTaskStatus(task.status, task.exitCode)}).`
				: `Background task ${task.id} emitted new output.`;

		pi.sendMessage(
			{
				content: `${headline}\nCommand: ${task.command}`,
				customType: BG_MESSAGE_TYPE,
				details,
				display: true,
			},
			eventType === "exit" ? { deliverAs: "followUp", triggerTurn: true } : { deliverAs: "steer", triggerTurn: true },
		);
	};

	const scheduleOutputReaction = (task: ManagedTask) => {
		if (!task.notifyOnOutput || task.status !== "running") return;
		if (task.outputTimer) clearTimeout(task.outputTimer);
		task.outputTimer = setTimeout(() => {
			task.outputTimer = null;
			const output = getTaskOutput(task);
			const unseenOutput = output.slice(task.lastAnnouncedLength);
			if (!unseenOutput.trim()) {
				task.lastAnnouncedLength = output.length;
				return;
			}
			if (task.matcher && !(task.matcher(unseenOutput) || task.matcher(output))) return;
			task.lastAnnouncedLength = output.length;
			sendTaskEvent("output", task, {
				matchedPattern: task.notifyPattern,
				newOutputTail: tailText(unseenOutput, settingNumber("outputAlertMaxChars", DEFAULT_OUTPUT_ALERT_MAX_CHARS, activeCtx?.cwd)),
			});
			refreshUi();
		}, settingNumber("outputSettleMs", DEFAULT_OUTPUT_SETTLE_MS, activeCtx?.cwd));
		task.outputTimer.unref?.();
	};

	const finalizeTask = (task: ManagedTask, exitCode: number | null, statusOverride?: BackgroundTaskStatus): ManagedTask => {
		if (task.closed) return task;
		task.closed = true;
		task.updatedAt = Date.now();
		task.exitCode = exitCode;
		clearTaskTimers(task);

		if (statusOverride) {
			task.status = statusOverride;
		} else if (task.stopReason === "timeout") {
			task.status = "timed_out";
		} else if (task.stopReason) {
			task.status = "stopped";
		} else {
			task.status = exitCode === 0 ? "completed" : "failed";
		}

		sendTaskEvent("exit", task);
		refreshUi();
		return task;
	};

	const appendLogLine = (task: ManagedTask, text: string) => {
		try {
			appendFileSync(task.logFile, text);
		} catch {
			// Keep in-memory output even if the log file is temporarily unavailable.
		}
	};

	const killTaskProcess = (task: ManagedTask, signal: NodeJS.Signals): boolean => {
		if (task.pid <= 0) return false;
		try {
			if (process.platform === "win32") {
				process.kill(task.pid, signal);
			} else {
				// We spawn detached on Unix, so -pid targets the task process group.
				process.kill(-task.pid, signal);
			}
			return true;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ESRCH") appendLogLine(task, `\n[kill error] ${String(error)}\n`);
			return false;
		}
	};

	const requestStop = (
		task: ManagedTask | null,
		reason: "user" | "timeout" | "shutdown" = "user",
	): { ok: boolean; message: string } => {
		if (!task) return { ok: false, message: "No background task matched that id or pid." };
		if (task.status !== "running") {
			return { ok: true, message: `${task.id} is already ${summarizeTaskStatus(task.status, task.exitCode)}.` };
		}

		task.stopReason = reason;
		task.updatedAt = Date.now();
		if (task.outputTimer) clearTimeout(task.outputTimer);
		task.outputTimer = null;

		const sent = killTaskProcess(task, "SIGTERM");
		if (!sent) {
			finalizeTask(task, task.exitCode, reason === "timeout" ? "timed_out" : "stopped");
			return { ok: true, message: `Stopped ${task.id} (${task.command}).` };
		}

		const forceKillGraceMs = settingNumber("forceKillGraceMs", DEFAULT_FORCE_KILL_GRACE_MS, activeCtx?.cwd);
		task.forceKillTimer = setTimeout(() => {
			if (task.status === "running" && !task.closed) {
				appendLogLine(task, `\n[stop] Escalating to SIGKILL after ${formatDuration(forceKillGraceMs)}.\n`);
				killTaskProcess(task, "SIGKILL");
			}
		}, forceKillGraceMs);
		task.forceKillTimer.unref?.();
		refreshUi();
		return { ok: true, message: `Stopping ${task.id} (${task.command}).` };
	};

	const spawnTask = (options: SpawnTaskOptions): ManagedTask => {
		const command = options.command.trim();
		if (!command) throw new Error("command is required for background task spawn");

		const cwd = options.cwd?.trim() || activeCtx?.cwd || process.cwd();
		const id = `bg-${++taskCounter}`;
		const now = Date.now();
		const timeoutSeconds = typeof options.timeoutSeconds === "number" ? options.timeoutSeconds : settingNumber("defaultTimeoutSeconds", DEFAULT_TIMEOUT_MS / 1_000, cwd);
		const expiresAt = timeoutSeconds > 0 ? now + timeoutSeconds * 1_000 : null;
		const logFile = logFilePath(id, now);
		writeFileSync(logFile, "");

		const { shell, args } = getShellConfig();
		const child = spawn(shell, [...args, command], {
			cwd,
			detached: process.platform !== "win32",
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		const task: ManagedTask = {
			child,
			closed: false,
			command,
			cwd,
			exitCode: null,
			expiresAt,
			forceKillTimer: null,
			id,
			lastAnnouncedLength: 0,
			lastOutputAt: null,
			logFile,
			matcher: parseOutputMatcher(options.notifyPattern),
			notifyOnExit: options.notifyOnExit ?? true,
			notifyOnOutput: options.notifyOnOutput ?? false,
			notifyPattern: options.notifyPattern?.trim() || undefined,
			output: "",
			outputBytes: 0,
			outputTimer: null,
			pid: child.pid ?? 0,
			startedAt: now,
			status: "running",
			stopReason: null,
			timeoutTimer: null,
			title: options.title?.trim() || command,
			updatedAt: now,
		};
		tasks.set(task.id, task);

		const handleChunk = (chunk: Buffer) => {
			const text = chunk.toString();
			task.updatedAt = Date.now();
			task.lastOutputAt = task.updatedAt;
			task.outputBytes += chunk.byteLength;
			task.output += text;
			const trimmed = trimOutputBuffer(task.output, task.lastAnnouncedLength);
			task.output = trimmed.output;
			task.lastAnnouncedLength = trimmed.lastAnnouncedLength;
			appendLogLine(task, text);
			scheduleOutputReaction(task);
			refreshUi();
		};

		child.stdout?.on("data", handleChunk);
		child.stderr?.on("data", handleChunk);
		child.on("close", (code) => finalizeTask(task, typeof code === "number" ? code : null));
		child.on("error", (error) => {
			handleChunk(Buffer.from(`\n[spawn error] ${error.message}\n`));
			finalizeTask(task, 1, "failed");
		});

		if (expiresAt != null) {
			task.timeoutTimer = setTimeout(() => {
				appendLogLine(task, `\n[timeout] Background task exceeded ${formatDuration(timeoutSeconds * 1_000)}.\n`);
				requestStop(task, "timeout");
			}, Math.max(1, timeoutSeconds * 1_000));
			task.timeoutTimer.unref?.();
		}

		refreshUi();
		return task;
	};

	const clearFinishedTasks = (): number => {
		let removed = 0;
		for (const [id, task] of tasks) {
			if (task.status === "running") continue;
			clearTaskTimers(task);
			tasks.delete(id);
			removed += 1;
		}
		refreshUi();
		return removed;
	};

	const formatTaskListText = (): string => {
		const sorted = sortedTasks();
		if (sorted.length === 0) return "No background tasks.";
		return sorted.map((task) => buildTaskSummaryLine(taskSnapshot(task))).join("\n\n");
	};

	const resolveTask = (id?: string, pid?: number): ManagedTask | null => resolveTaskByToken(tasks.values(), id ?? pid);

	const openDashboard = async (
		ctx: ExtensionCommandContext | ExtensionContext,
		initialTask: ManagedTask | null = null,
	): Promise<void> => {
		if (!ctx.hasUI) {
			ctx.ui.notify(formatTaskListText(), "info");
			return;
		}

		await ctx.ui.custom(
			(tui, theme, _keybindings, done) => {
				let selectedId: string | null = initialTask?.id ?? sortedTasks()[0]?.id ?? null;
				let taskScroll = 0;
				let outputScroll = 0;
				let followOutput = true;
				let timer: ReturnType<typeof setInterval> | null = setInterval(() => tui.requestRender(), 1_000);
				timer.unref?.();

				const selectedTask = (): ManagedTask | null => {
					const sorted = sortedTasks();
					if (sorted.length === 0) return null;
					const current = selectedId ? tasks.get(selectedId) : undefined;
					if (current) return current;
					selectedId = sorted[0]?.id ?? null;
					return selectedId ? (tasks.get(selectedId) ?? null) : null;
				};

				const getOutputLines = (task: ManagedTask | null): string[] => splitOutputLines(task ? getTaskOutput(task) : "");
				const maxOutputScroll = (task: ManagedTask | null): number => Math.max(0, getOutputLines(task).length - DASHBOARD_OUTPUT_ROWS);

				const syncTaskScroll = () => {
					const sorted = sortedTasks();
					const index = Math.max(
						0,
						sorted.findIndex((task) => task.id === selectedId),
					);
					const max = Math.max(0, sorted.length - DASHBOARD_TASK_ROWS);
					if (index < taskScroll) taskScroll = index;
					if (index >= taskScroll + DASHBOARD_TASK_ROWS) taskScroll = index - DASHBOARD_TASK_ROWS + 1;
					taskScroll = clamp(taskScroll, 0, max);
				};

				const syncOutputScroll = (forceBottom = false) => {
					const max = maxOutputScroll(selectedTask());
					if (forceBottom || followOutput) outputScroll = max;
					else outputScroll = clamp(outputScroll, 0, max);
				};

				const moveSelection = (delta: number) => {
					const sorted = sortedTasks();
					if (sorted.length === 0) {
						selectedId = null;
						return;
					}
					const currentIndex = Math.max(
						0,
						sorted.findIndex((task) => task.id === selectedId),
					);
					selectedId = sorted[clamp(currentIndex + delta, 0, sorted.length - 1)]?.id ?? null;
					syncTaskScroll();
					syncOutputScroll(true);
					tui.requestRender();
				};

				const moveOutput = (delta: number) => {
					followOutput = false;
					outputScroll = clamp(outputScroll + delta, 0, maxOutputScroll(selectedTask()));
					if (outputScroll >= maxOutputScroll(selectedTask())) followOutput = true;
					tui.requestRender();
				};

				const renderLines = (width: number): string[] => {
					const sorted = sortedTasks();
					const running = sorted.filter((task) => task.status === "running").length;
					const selected = selectedTask();
					syncTaskScroll();
					syncOutputScroll();

					const lines = [
						`${theme.fg("accent", theme.bold("⚙ Background tasks"))} ${theme.fg(
							"muted",
							`${running} running · ${sorted.length - running} finished`,
						)}`,
						theme.fg("dim", "[↑↓/jk] select · [s] stop · [c] clear · [f] follow · [PgUp/PgDn] scroll · [q/esc] close"),
						"",
					];

					if (sorted.length === 0) {
						lines.push(theme.fg("dim", "No background tasks yet. Use /bg run <command> or the bg_task tool."));
						return lines.map((line) => truncateToWidth(line, width, ""));
					}

					const taskPaneWidth = clamp(Math.floor(width * 0.34), TASK_PANE_MIN_WIDTH, TASK_PANE_MAX_WIDTH);
					const detailPaneWidth = Math.max(24, width - taskPaneWidth - 3);
					const left: string[] = [];
					const right: string[] = [];

					left.push(`${theme.fg("accent", theme.bold("Tasks"))} ${theme.fg("dim", `(${sorted.length})`)}`);
					left.push("");
					if (taskScroll > 0) left.push(theme.fg("dim", `↑ ${taskScroll} earlier task(s)`));
					for (const task of sorted.slice(taskScroll, taskScroll + DASHBOARD_TASK_ROWS)) {
						const selectedMarker = task.id === selected?.id ? theme.fg("accent", "→") : theme.fg("dim", "·");
						const statusColor = task.status === "running" ? "success" : task.status === "failed" ? "error" : "muted";
						left.push(`${selectedMarker} ${theme.fg(statusColor, task.id)} ${theme.fg("dim", summarizeTaskStatus(task.status, task.exitCode))}`);
						left.push(`  ${taskDisplayName(task)}`);
					}
					const hiddenBelow = Math.max(0, sorted.length - (taskScroll + DASHBOARD_TASK_ROWS));
					if (hiddenBelow > 0) left.push(theme.fg("dim", `↓ ${hiddenBelow} more task(s)`));

					if (!selected) {
						right.push(theme.fg("dim", "Select a task to inspect output."));
					} else {
						const outputLines = getOutputLines(selected);
						const visibleOutput = outputLines.slice(outputScroll, outputScroll + DASHBOARD_OUTPUT_ROWS);
						right.push(`${theme.fg("accent", theme.bold(`Watch ${selected.id}`))} ${theme.fg("dim", followOutput ? "follow" : `line ${outputScroll + 1}`)}`);
						right.push(`${theme.fg("muted", "Status")}: ${summarizeTaskStatus(selected.status, selected.exitCode)} · pid ${selected.pid}`);
						right.push(`${theme.fg("muted", "Started")}: ${formatRelativeTime(selected.startedAt)} · ${formatDuration(Date.now() - selected.startedAt)} elapsed`);
						if (selected.expiresAt != null) right.push(`${theme.fg("muted", "Expiry")}: ${formatRelativeTime(selected.expiresAt)}`);
						right.push(`${theme.fg("muted", "Command")}: ${selected.command}`);
						right.push(`${theme.fg("muted", "Cwd")}: ${selected.cwd}`);
						right.push(`${theme.fg("muted", "Log")}: ${selected.logFile}`);
						right.push(
							`${theme.fg("muted", "Wakeups")}: exit=${selected.notifyOnExit ? "yes" : "no"}, output=${
								selected.notifyOnOutput ? (selected.notifyPattern ?? "yes") : "no"
							}`,
						);
						right.push("", theme.fg("accent", theme.bold("Output")));
						if (outputScroll > 0) right.push(theme.fg("dim", `↑ ${outputScroll} older line(s)`));
						right.push(...visibleOutput);
						const below = Math.max(0, outputLines.length - (outputScroll + DASHBOARD_OUTPUT_ROWS));
						if (below > 0) right.push(theme.fg("dim", `↓ ${below} newer line(s)`));
					}

					const rowCount = Math.max(left.length, right.length);
					for (let i = 0; i < rowCount; i += 1) {
						lines.push(`${padAnsi(left[i] ?? "", taskPaneWidth)}${theme.fg("dim", " │ ")}${truncateToWidth(right[i] ?? "", detailPaneWidth, "")}`);
					}
					return lines.map((line) => truncateToWidth(line, width, ""));
				};

				return {
					dispose() {
						if (timer) clearInterval(timer);
						timer = null;
					},
					handleInput(data: string) {
						if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") {
							done(undefined);
							return;
						}
						if (matchesKey(data, "up") || data === "k") return moveSelection(-1);
						if (matchesKey(data, "down") || data === "j") return moveSelection(1);
						if (matchesKey(data, "home") || data === "g") return moveSelection(-Number.MAX_SAFE_INTEGER);
						if (matchesKey(data, "end") || data === "G") return moveSelection(Number.MAX_SAFE_INTEGER);
						if (matchesKey(data, "pageup") || matchesKey(data, "shift+up")) return moveOutput(-DASHBOARD_OUTPUT_ROWS);
						if (matchesKey(data, "pagedown") || matchesKey(data, "shift+down")) return moveOutput(DASHBOARD_OUTPUT_ROWS);
						if (data === "f") {
							followOutput = !followOutput;
							syncOutputScroll(followOutput);
							tui.requestRender();
							return;
						}
						if (data === "s") {
							requestStop(selectedTask(), "user");
							tui.requestRender();
							return;
						}
						if (data === "c") {
							clearFinishedTasks();
							tui.requestRender();
						}
					},
					invalidate() {},
					render(width: number) {
						return renderLines(width);
					},
				};
			},
			{ overlay: true, overlayOptions: { anchor: "center", maxHeight: DASHBOARD_MAX_HEIGHT, width: DASHBOARD_WIDTH } },
		);
	};

	pi.registerMessageRenderer(BG_MESSAGE_TYPE, (message, { expanded }, theme) => renderTaskEventMessage(message, expanded, theme));

	pi.on("session_start", (_event, ctx) => {
		shuttingDown = false;
		activeCtx = ctx;
		syncWidget(ctx);
	});
	pi.on("before_agent_start", (_event, ctx) => {
		activeCtx = ctx;
		syncWidget(ctx);
	});
	pi.on("session_tree", (_event, ctx) => {
		activeCtx = ctx;
		syncWidget(ctx);
	});
	pi.on("session_compact", (_event, ctx) => {
		activeCtx = ctx;
		syncWidget(ctx);
	});
	pi.on("session_shutdown", () => {
		shuttingDown = true;
		for (const task of tasks.values()) {
			if (task.status === "running") {
				task.stopReason = "shutdown";
				killTaskProcess(task, "SIGTERM");
				killTaskProcess(task, "SIGKILL");
			}
			clearTaskTimers(task);
		}
		clearWidget();
		activeCtx = null;
	});

	pi.registerTool({
		name: "bg_status",
		label: "Background Process Status",
		description: "List, tail, or stop background tasks spawned by bg_task or /bg. Use pid for log/stop.",
		parameters: Type.Object({
			action: StringEnum(["list", "log", "stop"] as const, {
				description: "list=show tracked tasks, log=view task output by pid, stop=terminate by pid",
			}),
			pid: Type.Optional(Type.Number({ description: "Task pid for action=log or action=stop" })),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<unknown>> {
			if (params.action === "list") return makeToolResult(formatTaskListText());
			const task = resolveTask(undefined, params.pid);
			if (!task) throw new Error("No background task matched that pid.");
			if (params.action === "log") return makeToolResult(tailText(getTaskOutput(task), settingNumber("logTailMaxChars", DEFAULT_LOG_TAIL_MAX_CHARS, activeCtx?.cwd)) || "(empty)");
			const stopped = requestStop(task, "user");
			if (!stopped.ok) throw new Error(stopped.message);
			return makeToolResult(stopped.message, { task: taskSnapshot(task) });
		},
	});

	pi.registerTool({
		name: "bg_task",
		label: "Background Task",
		description:
			"Spawn, inspect, and stop explicit background shell tasks without blocking the current turn. Tasks write persistent logs, default to a 10-minute timeout, stop as a process group on Unix, and can wake the agent on exit or matching output.",
		promptSnippet: "Spawn, inspect, and stop explicit non-blocking background shell tasks.",
		promptGuidelines: [
			"Use bg_task instead of bash backgrounding/nohup when the user wants a long-running command to continue while the conversation remains usable.",
			"Use bg_task list/log/stop to inspect or terminate tasks started by bg_task or /bg.",
		],
		parameters: Type.Object({
			action: StringEnum(["spawn", "list", "log", "stop", "clear"] as const, {
				description: "spawn=start a task, list=show tasks, log=view output, stop=terminate, clear=remove finished tasks",
			}),
			command: Type.Optional(Type.String({ description: "Shell command for action=spawn" })),
			cwd: Type.Optional(Type.String({ description: "Working directory for action=spawn" })),
			id: Type.Optional(Type.String({ description: "Task id for action=log or action=stop" })),
			notifyOnExit: Type.Optional(Type.Boolean({ description: "Wake the agent when the task exits. Defaults to true." })),
			notifyOnOutput: Type.Optional(Type.Boolean({ description: "Wake the agent when new output arrives. Defaults to false." })),
			notifyPattern: Type.Optional(Type.String({ description: "Substring or /regex/flags gate for output wakeups." })),
			pid: Type.Optional(Type.Number({ description: "PID for action=log or action=stop" })),
			timeoutSeconds: Type.Optional(Type.Number({ description: "Timeout for spawned tasks. Defaults to 600. Use 0 to disable." })),
			title: Type.Optional(Type.String({ description: "Optional display label for action=spawn" })),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<unknown>> {
			if (params.action === "list") return makeToolResult(formatTaskListText());
			if (params.action === "clear") return makeToolResult(`Removed ${clearFinishedTasks()} finished background task(s).`);

			if (params.action === "spawn") {
				const task = spawnTask({
					command: params.command ?? "",
					cwd: params.cwd,
					notifyOnExit: params.notifyOnExit,
					notifyOnOutput: params.notifyOnOutput,
					notifyPattern: params.notifyPattern,
					timeoutSeconds: params.timeoutSeconds,
					title: params.title,
				});
				return makeToolResult(
					`Started ${task.id} (pid ${task.pid}) in the background.\nCommand: ${task.command}\nCwd: ${task.cwd}\nLog: ${task.logFile}\nExpiry: ${
						task.expiresAt != null ? formatRelativeTime(task.expiresAt) : "none"
					}\nWakeups: exit=${task.notifyOnExit ? "yes" : "no"}, output=${
						task.notifyOnOutput ? (task.notifyPattern ?? "yes") : "no"
					}`,
					{ task: taskSnapshot(task) },
				);
			}

			const task = resolveTask(params.id, params.pid);
			if (!task) throw new Error("No background task matched that id or pid.");
			if (params.action === "log") return makeToolResult(tailText(getTaskOutput(task), settingNumber("logTailMaxChars", DEFAULT_LOG_TAIL_MAX_CHARS, activeCtx?.cwd)) || "(empty)");
			const stopped = requestStop(task, "user");
			if (!stopped.ok) throw new Error(stopped.message);
			return makeToolResult(stopped.message, { task: taskSnapshot(task) });
		},
	});

	pi.registerCommand(BG_COMMAND, {
		description: "Manage background shell tasks: /bg, /bg run <cmd>, /bg log <id>, /bg stop <id>, /bg clear.",
		getArgumentCompletions(prefix) {
			const trimmed = prefix.trimStart();
			const parts = trimmed.split(/\s+/).filter(Boolean);
			if (parts.length <= 1) {
				return [
					{ label: "dashboard", value: "dashboard", description: "Open the task dashboard" },
					{ label: "list", value: "list", description: "Show tracked tasks" },
					{ label: "run", value: "run ", description: "Spawn a background shell task" },
					{ label: "log", value: "log ", description: "Show task log tail" },
					{ label: "stop", value: "stop ", description: "Terminate a running task" },
					{ label: "clear", value: "clear", description: "Remove finished tasks" },
				].filter((option) => option.value.trim().startsWith(trimmed.toLowerCase()));
			}
			const [subcommand] = parts;
			if (!(subcommand === "log" || subcommand === "stop" || subcommand === "watch")) return null;
			return sortedTasks().map((task) => ({
				description: `${summarizeTaskStatus(task.status, task.exitCode)} · ${task.command}`,
				label: task.id,
				value: task.id,
			}));
		},
		handler: async (args, ctx) => {
			activeCtx = ctx;
			const trimmed = args.trim();
			if (!trimmed || trimmed === "dashboard") {
				await openDashboard(ctx);
				return;
			}
			if (trimmed === "list" || trimmed === "status") {
				ctx.ui.notify(formatTaskListText(), "info");
				return;
			}
			if (trimmed === "clear") {
				ctx.ui.notify(`Removed ${clearFinishedTasks()} finished background task(s).`, "info");
				return;
			}
			if (trimmed.startsWith("run ")) {
				const task = spawnTask({ command: trimmed.slice(4), cwd: ctx.cwd });
				ctx.ui.notify(`Started ${task.id} (pid ${task.pid}) in the background.`, "info");
				return;
			}
			const inspectMatch = trimmed.match(/^(?:watch|log)\s+(.+)$/);
			if (inspectMatch) {
				const task = resolveTask(inspectMatch[1]?.trim());
				if (!task) {
					ctx.ui.notify("No background task matched that id or pid.", "warning");
					return;
				}
				if (trimmed.startsWith("log ")) ctx.ui.notify(tailText(getTaskOutput(task), settingNumber("logTailMaxChars", DEFAULT_LOG_TAIL_MAX_CHARS, ctx.cwd)) || "(empty)", "info");
				else await openDashboard(ctx, task);
				return;
			}
			if (trimmed.startsWith("stop ")) {
				const stopped = requestStop(resolveTask(trimmed.slice(5).trim()), "user");
				ctx.ui.notify(stopped.message, stopped.ok ? "info" : "warning");
				return;
			}
			ctx.ui.notify(
				`Unknown /${BG_COMMAND} action. Try /${BG_COMMAND}, /${BG_COMMAND} run <command>, /${BG_COMMAND} log <id>, /${BG_COMMAND} stop <id>, or /${BG_COMMAND} clear.`,
				"warning",
			);
		},
	});

	if (dashboardShortcut !== "none") {
		pi.registerShortcut(dashboardShortcut, {
			description: "Open the background task dashboard",
			handler: async (ctx) => {
				activeCtx = ctx as ExtensionContext;
				await openDashboard(ctx as ExtensionContext);
			},
		});
	}
}
