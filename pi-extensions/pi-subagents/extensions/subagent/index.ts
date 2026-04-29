/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import { StringEnum } from "@mariozechner/pi-ai";
import { type AgentToolResult, type ExtensionAPI, getMarkdownTheme, withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents, formatAgentList } from "./agents.js";

const INSTALL_SYMBOL = Symbol.for("vstack.pi-subagents.installed");
const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PANE_LAUNCHER_VERSION = 5;
const FIRST_AGENT_COLUMN_ROWS = 3;
const NEXT_AGENT_COLUMN_ROWS = 4;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

interface PaneRegistryEntry {
	agent: string;
	paneId: string;
	windowName: string;
	cwd: string;
	sessionFile: string;
	promptFile: string;
	launcherFile: string;
	model?: string;
	thinkingLevel?: string;
	startedAt: string;
	lastTaskAt?: string;
	lastTaskId?: string;
	launcherVersion?: number;
	layoutGroup?: number;
	primaryPaneId?: string;
}

interface PaneCompletion {
	agent?: string;
	taskId?: string;
	status?: "completed" | "blocked" | "failed";
	summary?: string;
	filesChanged?: string[];
	validation?: string[];
	notes?: string;
}

type PaneRegistry = Record<string, PaneRegistryEntry>;

function safeFileName(value: string): string {
	return value.replace(/[^\w.-]+/g, "_");
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function setCurrentTmuxPaneTitle(title: string): void {
	const paneId = process.env.TMUX_PANE;
	if (!paneId) return;
	const proc = spawn("tmux", ["select-pane", "-t", paneId, "-T", title], { stdio: "ignore" });
	proc.on("error", () => undefined);
	proc.unref?.();
}

function runtimeDir(cwd: string): string {
	return path.join(cwd, ".pi", "subagent-runtime");
}

function registryPath(cwd: string): string {
	return path.join(runtimeDir(cwd), "panes.json");
}

function outboxRoot(cwd: string): string {
	return path.join(runtimeDir(cwd), "outbox");
}

function completionPath(cwd: string, agentName: string, taskId: string): string {
	return path.join(outboxRoot(cwd), safeFileName(agentName), `${safeFileName(taskId)}.json`);
}

function inboxDir(cwd: string, agentName: string): string {
	return path.join(runtimeDir(cwd), "inbox", safeFileName(agentName));
}

function completionArchiveDir(cwd: string, agentName: string): string {
	return path.join(runtimeDir(cwd), "processed", safeFileName(agentName));
}

function createTaskId(agentName: string): string {
	return `${safeFileName(agentName)}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function buildDelegation(agent: AgentConfig, task: string, outboxFile: string, taskId: string): string {
	const compactTask = task.replace(/\s+/g, " ").trim();
	const schema = JSON.stringify({
		agent: agent.name,
		taskId,
		status: "completed|blocked|failed",
		summary: "1-3 sentence result",
		filesChanged: ["path/or empty"],
		validation: ["command/result or empty"],
		notes: "optional",
	});
	return `DELEGATION for ${agent.name}. Task ID: ${taskId}. Task: ${compactTask}. Completion protocol mandatory: when the delegation is complete, write exactly one JSON object to ${outboxFile} using this schema ${schema}. Then print one brief final message in your pane and go idle. Do not write the completion file before the work is actually done.`;
}

async function execCapture(command: string, args: string[], options?: { cwd?: string }): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const proc = spawn(command, args, { cwd: options?.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (data) => (stdout += data.toString()));
		proc.stderr.on("data", (data) => (stderr += data.toString()));
		proc.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
		proc.on("error", (error) => resolve({ code: 1, stdout, stderr: String(error) }));
	});
}

async function tmux(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	return execCapture("tmux", args);
}

async function ensureTmux(): Promise<void> {
	if (!process.env.TMUX) throw new Error("Persistent pane agents require tmux ($TMUX is unset).");
	const result = await tmux(["display-message", "-p", "#S"]);
	if (result.code !== 0) throw new Error(`tmux is unavailable: ${result.stderr || result.stdout}`.trim());
}

async function paneExists(paneId: string): Promise<boolean> {
	const result = await tmux(["display-message", "-p", "-t", paneId, "#{pane_id}"]);
	return result.code === 0 && result.stdout.trim() === paneId;
}

async function getPrimaryPaneId(): Promise<string> {
	if (process.env.TMUX_PANE && (await paneExists(process.env.TMUX_PANE))) return process.env.TMUX_PANE;
	const result = await tmux(["display-message", "-p", "#{pane_id}"]);
	if (result.code === 0 && result.stdout.trim()) return result.stdout.trim();
	throw new Error(`Unable to determine primary tmux pane: ${result.stderr || result.stdout}`.trim());
}

function columnCapacity(group: number): number {
	return group <= 1 ? FIRST_AGENT_COLUMN_ROWS : NEXT_AGENT_COLUMN_ROWS;
}

function sortPaneEntries(entries: PaneRegistryEntry[]): PaneRegistryEntry[] {
	return [...entries].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.agent.localeCompare(b.agent));
}

function groupedPaneEntries(registry: PaneRegistry): Map<number, PaneRegistryEntry[]> {
	const groups = new Map<number, PaneRegistryEntry[]>();
	for (const entry of sortPaneEntries(Object.values(registry))) {
		if (!entry.layoutGroup) continue;
		const group = groups.get(entry.layoutGroup) ?? [];
		group.push(entry);
		groups.set(entry.layoutGroup, group);
	}
	return groups;
}

function nextLayoutGroup(registry: PaneRegistry): number {
	const groups = groupedPaneEntries(registry);
	for (let group = 1; group <= 16; group += 1) {
		if ((groups.get(group)?.length ?? 0) < columnCapacity(group)) return group;
	}
	return Math.max(1, groups.size + 1);
}

async function cleanupPaneRegistry(registry: PaneRegistry): Promise<boolean> {
	let changed = false;
	for (const [agentName, entry] of Object.entries(registry)) {
		if (!(await paneExists(entry.paneId))) {
			delete registry[agentName];
			changed = true;
			continue;
		}
		if (entry.launcherVersion !== PANE_LAUNCHER_VERSION) {
			await tmux(["kill-pane", "-t", entry.paneId]);
			delete registry[agentName];
			changed = true;
		}
	}
	return changed;
}

async function rebalanceColumn(entries: PaneRegistryEntry[]): Promise<void> {
	if (entries.length <= 1) return;
	const sorted = sortPaneEntries(entries);
	const heightResult = await tmux(["display-message", "-p", "-t", sorted[0].paneId, "#{window_height}"]);
	const windowHeight = Number.parseInt(heightResult.stdout.trim(), 10);
	if (heightResult.code !== 0 || !Number.isFinite(windowHeight) || windowHeight <= 0) return;

	const availablePaneRows = Math.max(sorted.length, windowHeight - (sorted.length - 1));
	const targetHeight = Math.max(3, Math.floor(availablePaneRows / sorted.length));
	for (const entry of sorted.slice(0, -1)) {
		await tmux(["resize-pane", "-t", entry.paneId, "-y", String(targetHeight)]);
	}
}

async function rebalanceColumns(registry: PaneRegistry, primaryPaneId: string): Promise<void> {
	const groups = groupedPaneEntries(registry);
	const columns = [{ paneId: primaryPaneId, group: 0 }];
	for (const [group, entries] of [...groups.entries()].sort(([a], [b]) => a - b)) {
		const representative = sortPaneEntries(entries)[0];
		if (representative) columns.push({ paneId: representative.paneId, group });
	}
	if (columns.length <= 1) return;

	const measured: Array<{ paneId: string; left: number; windowWidth: number }> = [];
	for (const column of columns) {
		if (!(await paneExists(column.paneId))) continue;
		const result = await tmux(["display-message", "-p", "-t", column.paneId, "#{pane_left}\t#{window_width}"]);
		const [leftText, windowWidthText] = result.stdout.trim().split("\t");
		const left = Number.parseInt(leftText ?? "", 10);
		const windowWidth = Number.parseInt(windowWidthText ?? "", 10);
		if (result.code === 0 && Number.isFinite(left) && Number.isFinite(windowWidth)) measured.push({ paneId: column.paneId, left, windowWidth });
	}
	if (measured.length <= 1) return;

	measured.sort((a, b) => a.left - b.left);
	const windowWidth = measured[0].windowWidth;
	const availablePaneColumns = Math.max(measured.length, windowWidth - (measured.length - 1));
	const baseWidth = Math.max(10, Math.floor(availablePaneColumns / measured.length));
	const remainder = Math.max(0, availablePaneColumns - baseWidth * measured.length);
	for (const [index, column] of measured.entries()) {
		const targetWidth = baseWidth + (index >= measured.length - remainder ? 1 : 0);
		await tmux(["resize-pane", "-t", column.paneId, "-x", String(targetWidth)]);
	}
}

async function readPaneRegistry(cwd: string): Promise<PaneRegistry> {
	try {
		const content = await fs.promises.readFile(registryPath(cwd), "utf-8");
		return JSON.parse(content) as PaneRegistry;
	} catch {
		return {};
	}
}

async function writePaneRegistry(cwd: string, registry: PaneRegistry): Promise<void> {
	const filePath = registryPath(cwd);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
		await fs.promises.writeFile(filePath, `${JSON.stringify(registry, null, "\t")}\n`, "utf-8");
	});
}

async function writeLauncher(
	cwd: string,
	agent: AgentConfig,
	model: string | undefined,
	thinkingLevel: string | undefined,
): Promise<{ sessionFile: string; promptFile: string; launcherFile: string }> {
	const dir = runtimeDir(cwd);
	const safeName = safeFileName(agent.name);
	const sessionsDir = path.join(dir, "sessions");
	const promptsDir = path.join(dir, "prompts");
	const launchersDir = path.join(dir, "launchers");
	await fs.promises.mkdir(sessionsDir, { recursive: true });
	await fs.promises.mkdir(promptsDir, { recursive: true });
	await fs.promises.mkdir(launchersDir, { recursive: true });

	const sessionFile = path.join(sessionsDir, `${safeName}.jsonl`);
	const promptFile = path.join(promptsDir, `${safeName}.md`);
	const launcherFile = path.join(launchersDir, `${safeName}.sh`);

	await withFileMutationQueue(promptFile, async () => {
		await fs.promises.writeFile(promptFile, agent.systemPrompt, { encoding: "utf-8", mode: 0o600 });
	});

	const args = ["--session", sessionFile, "--append-system-prompt", promptFile];
	if (model) args.push("--model", model);
	if (thinkingLevel && thinkingLevel !== "off") args.push("--thinking", thinkingLevel);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	const invocation = getPiInvocation(args);
	const command = [invocation.command, ...invocation.args].map(shellQuote).join(" ");
	const script = `#!/usr/bin/env bash
set -euo pipefail
cd ${shellQuote(cwd)}
export PI_SUBAGENT_CHILD_AGENT=${shellQuote(agent.name)}
exec ${command}
`;
	await withFileMutationQueue(launcherFile, async () => {
		await fs.promises.writeFile(launcherFile, script, { encoding: "utf-8", mode: 0o700 });
	});

	return { sessionFile, promptFile, launcherFile };
}

async function ensurePersistentPane(
	cwd: string,
	agent: AgentConfig,
	parentModel: string | undefined,
	parentThinkingLevel: string | undefined,
): Promise<PaneRegistryEntry> {
	await ensureTmux();
	const registry = await readPaneRegistry(cwd);
	if (await cleanupPaneRegistry(registry)) await writePaneRegistry(cwd, registry);

	const existing = registry[agent.name];
	if (existing && (await paneExists(existing.paneId))) return existing;

	const selectedModel = parentModel ?? agent.model;
	const paths = await writeLauncher(cwd, agent, selectedModel, parentThinkingLevel);
	const windowName = `subagent:${agent.name}`;
	const primaryPaneId = await getPrimaryPaneId();
	const layoutGroup = nextLayoutGroup(registry);
	const groupEntries = groupedPaneEntries(registry).get(layoutGroup) ?? [];
	const splitHorizontally = groupEntries.length === 0;
	const splitTarget = splitHorizontally ? primaryPaneId : groupEntries[0].paneId;
	const splitPercent = splitHorizontally ? "50" : String(Math.max(10, Math.floor(100 / (groupEntries.length + 1))));
	const result = await tmux([
		"split-window",
		splitHorizontally ? "-h" : "-v",
		"-d",
		"-P",
		"-F",
		"#{pane_id}",
		"-p",
		splitPercent,
		"-t",
		splitTarget,
		"-c",
		cwd,
		"bash",
		paths.launcherFile,
	]);
	if (result.code !== 0) throw new Error(`Failed to launch tmux pane for ${agent.name}: ${result.stderr || result.stdout}`.trim());
	const paneId = result.stdout.trim();
	await tmux(["select-pane", "-t", paneId, "-T", windowName]);
	await tmux(["set-window-option", "-t", paneId, "pane-border-status", "top"]);
	await tmux([
		"set-window-option",
		"-t",
		paneId,
		"pane-border-format",
		"#{?pane_active,#[bold fg=colour39],#[fg=colour245]} #T #[default]",
	]);

	const entry: PaneRegistryEntry = {
		agent: agent.name,
		paneId,
		windowName,
		cwd,
		sessionFile: paths.sessionFile,
		promptFile: paths.promptFile,
		launcherFile: paths.launcherFile,
		model: selectedModel,
		thinkingLevel: parentThinkingLevel,
		startedAt: new Date().toISOString(),
		launcherVersion: PANE_LAUNCHER_VERSION,
		layoutGroup,
		primaryPaneId,
	};
	registry[agent.name] = entry;
	await rebalanceColumn([...(groupedPaneEntries(registry).get(layoutGroup) ?? [])]);
	await rebalanceColumns(registry, primaryPaneId);
	await writePaneRegistry(cwd, registry);
	return entry;
}

async function archiveCompletion(cwd: string, agentName: string, filePath: string): Promise<void> {
	const archiveDir = completionArchiveDir(cwd, agentName);
	await fs.promises.mkdir(archiveDir, { recursive: true });
	const archivedPath = path.join(archiveDir, `${Date.now()}-${path.basename(filePath)}`);
	await fs.promises.rename(filePath, archivedPath);
}

function formatCompletion(completion: PaneCompletion, filePath: string): string {
	const files = completion.filesChanged?.length ? completion.filesChanged.map((file) => `- ${file}`).join("\n") : "None reported";
	const validation = completion.validation?.length
		? completion.validation.map((item) => `- ${item}`).join("\n")
		: "None reported";
	return [
		`# Subagent completion: ${completion.agent ?? "unknown"}`,
		`Task ID: ${completion.taskId ?? "unknown"}`,
		`Status: ${completion.status ?? "unknown"}`,
		`Source: ${filePath}`,
		"",
		"## Summary",
		completion.summary ?? "No summary provided.",
		"",
		"## Files Changed",
		files,
		"",
		"## Validation",
		validation,
		completion.notes ? `\n## Notes\n${completion.notes}` : "",
	]
		.filter(Boolean)
		.join("\n");
}

async function pollPaneCompletions(cwd: string, pi: ExtensionAPI, triggerTurn = true): Promise<number> {
	let collected = 0;
	const root = outboxRoot(cwd);
	let agentDirs: fs.Dirent[];
	try {
		agentDirs = await fs.promises.readdir(root, { withFileTypes: true });
	} catch {
		return collected;
	}

	for (const agentDir of agentDirs) {
		if (!agentDir.isDirectory()) continue;
		const dir = path.join(root, agentDir.name);
		let files: string[];
		try {
			files = (await fs.promises.readdir(dir)).filter((file) => file.endsWith(".json"));
		} catch {
			continue;
		}

		for (const file of files) {
			const filePath = path.join(dir, file);
			try {
				const completion = JSON.parse(await fs.promises.readFile(filePath, "utf-8")) as PaneCompletion;
				const content = formatCompletion(completion, filePath);
				pi.sendMessage(
					{ customType: "subagent-completion", content, display: true },
					triggerTurn ? { triggerTurn: true, deliverAs: "followUp" } : undefined,
				);
				await archiveCompletion(cwd, completion.agent ?? agentDir.name, filePath);
				collected++;
			} catch {
				// Leave malformed or concurrently-written files in place for the agent/user to fix.
			}
		}
	}
	return collected;
}

async function runPersistentPaneAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	parentModel: string | undefined,
	parentThinkingLevel: string | undefined,
	step: number | undefined,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);
	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	const effectiveCwd = cwd ?? defaultCwd;
	const pane = await ensurePersistentPane(effectiveCwd, agent, parentModel, parentThinkingLevel);
	const taskId = createTaskId(agent.name);
	const outboxFile = completionPath(effectiveCwd, agent.name, taskId);
	await fs.promises.mkdir(path.dirname(outboxFile), { recursive: true });
	const delegation = buildDelegation(agent, task, outboxFile, taskId);
	const taskFile = path.join(inboxDir(effectiveCwd, agent.name), `${safeFileName(taskId)}.md`);
	await fs.promises.mkdir(path.dirname(taskFile), { recursive: true });
	await fs.promises.writeFile(taskFile, delegation, { encoding: "utf-8", mode: 0o600 });
	const registry = await readPaneRegistry(effectiveCwd);
	if (registry[agent.name]) {
		registry[agent.name].lastTaskAt = new Date().toISOString();
		registry[agent.name].lastTaskId = taskId;
		await writePaneRegistry(effectiveCwd, registry);
	}

	const text = `Queued task ${taskId} for persistent tmux pane ${pane.paneId} (${pane.windowName}). Inbox file: ${taskFile}. Completion file: ${outboxFile}`;
	return {
		agent: agent.name,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [{ role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() } as Message],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: pane.model,
		step,
	};
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	parentModel: string | undefined,
	parentThinkingLevel: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	const selectedModel = parentModel ?? agent.model;
	if (selectedModel) args.push("--model", selectedModel);
	if (parentThinkingLevel && parentThinkingLevel !== "off") args.push("--thinking", parentThinkingLevel);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: selectedModel,
		step,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "project" (.pi/agents plus .claude/agents compatibility). Use "both" to include user-level agents too.',
	default: "project",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: false.", default: false }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

export default function (pi: ExtensionAPI) {
	const guard = globalThis as unknown as Record<PropertyKey, unknown>;
	if (guard[INSTALL_SYMBOL]) return;
	guard[INSTALL_SYMBOL] = true;

	const childAgentName = process.env.PI_SUBAGENT_CHILD_AGENT;
	let completionPoller: ReturnType<typeof setInterval> | undefined;
	let completionPollInFlight = false;
	let childInboxPoller: ReturnType<typeof setInterval> | undefined;
	let childTitlePoller: ReturnType<typeof setInterval> | undefined;
	let childPollInFlight = false;
	let childCurrentTaskFile: string | undefined;

	pi.registerMessageRenderer("subagent-agents", (message, _options, _theme) => {
		return new Text(message.content, 0, 0);
	});

	pi.registerMessageRenderer("subagent-completion", (message, _options, _theme) => {
		return new Text(message.content, 0, 0);
	});

	pi.on("session_start", (_event, ctx) => {
		if (completionPoller) clearInterval(completionPoller);
		if (childInboxPoller) clearInterval(childInboxPoller);
		if (childTitlePoller) clearInterval(childTitlePoller);

		if (childAgentName) {
			ctx.ui.setTitle(`pi subagent - ${childAgentName}`);
			setCurrentTmuxPaneTitle(`subagent:${childAgentName}`);
			childTitlePoller = setInterval(() => setCurrentTmuxPaneTitle(`subagent:${childAgentName}`), 1000);
			childTitlePoller.unref?.();
			ctx.ui.setStatus("subagent", `${childAgentName} idle`);
			if (ctx.hasUI) ctx.ui.setWidget("subagent-marker", undefined);
			const pollInbox = () => {
				if (childPollInFlight || !ctx.isIdle()) return;
				childPollInFlight = true;
				(async () => {
					const inbox = inboxDir(ctx.cwd, childAgentName);
					let files: string[];
					try {
						files = (await fs.promises.readdir(inbox)).filter((file) => file.endsWith(".md")).sort();
					} catch {
						return;
					}
					const file = files[0];
					if (!file) return;

					const source = path.join(inbox, file);
					const processing = path.join(runtimeDir(ctx.cwd), "processing", safeFileName(childAgentName), file);
					await fs.promises.mkdir(path.dirname(processing), { recursive: true });
					try {
						await fs.promises.rename(source, processing);
					} catch {
						return;
					}

					const prompt = await fs.promises.readFile(processing, "utf-8");
					childCurrentTaskFile = processing;
					ctx.ui.setStatus("subagent", `${childAgentName} running ${file}`);
					pi.sendUserMessage(prompt);
				})().finally(() => {
					childPollInFlight = false;
				});
			};
			pollInbox();
			childInboxPoller = setInterval(pollInbox, 1000);
			return;
		}

		ctx.ui.setStatus("subagent", undefined);
		if (!ctx.hasUI) return;
		const poll = () => {
			if (completionPollInFlight) return;
			completionPollInFlight = true;
			pollPaneCompletions(ctx.cwd, pi).finally(() => {
				completionPollInFlight = false;
			});
		};
		poll();
		completionPoller = setInterval(poll, 2000);
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!childAgentName || !childCurrentTaskFile) return;
		const doneFile = path.join(runtimeDir(ctx.cwd), "done", safeFileName(childAgentName), path.basename(childCurrentTaskFile));
		try {
			await fs.promises.mkdir(path.dirname(doneFile), { recursive: true });
			await fs.promises.rename(childCurrentTaskFile, doneFile);
		} catch {
			// Keep the processing file as evidence if archival fails.
		}
		childCurrentTaskFile = undefined;
		ctx.ui.setStatus("subagent", `${childAgentName} idle`);
	});

	pi.on("session_shutdown", () => {
		if (completionPoller) clearInterval(completionPoller);
		if (childInboxPoller) clearInterval(childInboxPoller);
		completionPoller = undefined;
		childInboxPoller = undefined;
	});

	pi.registerCommand("agents", {
		description: "List/show/manage subagents. Usage: /agents, /agents show <name>, /agents start|send|attach|stop|status|collect ...",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const scopes = new Set<AgentScope>(["user", "project", "both"]);
			const command = parts[0];
			let scope: AgentScope = "project";
			let content = "";

			const parentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			const parentThinkingLevel = pi.getThinkingLevel();
			const discovery = discoverAgents(ctx.cwd, scopes.has(parts.at(-1) as AgentScope) ? (parts.at(-1) as AgentScope) : scope);
			const findAgent = (name: string | undefined) => discovery.agents.find((candidate) => candidate.name === name);

			try {
				if (command === "start") {
					const agent = findAgent(parts[1]);
					if (!agent) throw new Error(`Unknown agent: ${parts[1] ?? "(missing)"}`);
					if (!agent.pane) throw new Error(`Agent ${agent.name} is not configured for persistent panes. Add \`pane: true\` to its frontmatter to enable.`);
					const pane = await ensurePersistentPane(ctx.cwd, agent, parentModel, parentThinkingLevel);
					content = `Started/reused ${agent.name} in ${pane.paneId} (${pane.windowName}).\nSession: ${pane.sessionFile}`;
				} else if (command === "send") {
					const agent = findAgent(parts[1]);
					if (!agent) throw new Error(`Unknown agent: ${parts[1] ?? "(missing)"}`);
					if (!agent.pane) throw new Error(`Agent ${agent.name} is not configured for persistent panes. Add \`pane: true\` to its frontmatter to enable.`);
					const task = parts.slice(2).join(" ").trim();
					if (!task) throw new Error("Usage: /agents send <name> <task>");
					const pane = await ensurePersistentPane(ctx.cwd, agent, parentModel, parentThinkingLevel);
					const taskId = createTaskId(agent.name);
					const outboxFile = completionPath(ctx.cwd, agent.name, taskId);
					await fs.promises.mkdir(path.dirname(outboxFile), { recursive: true });
					const taskFile = path.join(inboxDir(ctx.cwd, agent.name), `${safeFileName(taskId)}.md`);
					await fs.promises.mkdir(path.dirname(taskFile), { recursive: true });
					await fs.promises.writeFile(taskFile, buildDelegation(agent, task, outboxFile, taskId), {
						encoding: "utf-8",
						mode: 0o600,
					});
					const registry = await readPaneRegistry(ctx.cwd);
					if (registry[agent.name]) {
						registry[agent.name].lastTaskAt = new Date().toISOString();
						registry[agent.name].lastTaskId = taskId;
						await writePaneRegistry(ctx.cwd, registry);
					}
					content = `Queued task ${taskId} for ${agent.name} in ${pane.paneId} (${pane.windowName}).\nInbox file: ${taskFile}\nCompletion file: ${outboxFile}`;
				} else if (command === "attach") {
					const registry = await readPaneRegistry(ctx.cwd);
					const entry = registry[parts[1] ?? ""];
					if (!entry || !(await paneExists(entry.paneId))) throw new Error(`No live pane for agent: ${parts[1] ?? "(missing)"}`);
					const result = await tmux(["select-pane", "-t", entry.paneId]);
					if (result.code !== 0) throw new Error(result.stderr || result.stdout || "tmux select-pane failed");
					content = `Attached to ${entry.agent} at ${entry.paneId}.`;
				} else if (command === "stop") {
					const registry = await readPaneRegistry(ctx.cwd);
					const entry = registry[parts[1] ?? ""];
					if (!entry) throw new Error(`No pane registry entry for agent: ${parts[1] ?? "(missing)"}`);
					if (await paneExists(entry.paneId)) await tmux(["kill-pane", "-t", entry.paneId]);
					delete registry[entry.agent];
					await writePaneRegistry(ctx.cwd, registry);
					content = `Stopped ${entry.agent} pane ${entry.paneId}.`;
				} else if (command === "collect") {
					const collected = await pollPaneCompletions(ctx.cwd, pi, false);
					content = `Collected ${collected} subagent completion file${collected === 1 ? "" : "s"}.`;
				} else if (command === "status") {
					const registry = await readPaneRegistry(ctx.cwd);
					const lines = await Promise.all(
						Object.values(registry).map(async (entry) => {
							const live = await paneExists(entry.paneId);
							return `- ${entry.agent}: ${live ? "live" : "dead"} ${entry.paneId} ${entry.windowName} model=${entry.model ?? "default"} lastTask=${entry.lastTaskAt ?? "never"}`;
						}),
					);
					content = [`# Persistent subagent panes`, "", lines.join("\n") || "No persistent panes registered."].join("\n");
				} else {
					let showName: string | undefined;
					if (command === "show") {
						showName = parts[1];
						if (scopes.has(parts[2] as AgentScope)) scope = parts[2] as AgentScope;
					} else if (scopes.has(command as AgentScope)) {
						scope = command as AgentScope;
					} else if (command) {
						showName = command;
					}

					const scopedDiscovery = discoverAgents(ctx.cwd, scope);
					if (showName) {
						const agent = scopedDiscovery.agents.find((candidate) => candidate.name === showName);
						content = agent
							? [
									`# Agent: ${agent.name}`,
									`Source: ${agent.source}`,
									`Path: ${agent.filePath}`,
									`Model: ${agent.model ?? "default"}`,
									`Tools: ${agent.tools?.join(", ") ?? "default"}`,
									`Persistent pane: ${agent.pane ? "yes" : "no"}`,
									"",
									agent.description,
									"",
									"---",
									"",
									agent.systemPrompt.trim(),
								]
								.join("\n")
							: `Unknown agent "${showName}" for scope "${scope}". Available: ${scopedDiscovery.agents
									.map((agent) => agent.name)
									.join(", ") || "none"}.`;
					} else {
						const formatted = formatAgentList(scopedDiscovery.agents);
						content = [
							`# Available subagents (${scope})`,
							`Project agent dirs: ${scopedDiscovery.projectAgentsDir ?? "none"}`,
							"",
							formatted.text
								.split("; ")
								.map((line) => {
									const name = line.match(/^-?\s*([^ ]+)/)?.[1];
									const agent = scopedDiscovery.agents.find((candidate) => candidate.name === name);
									return `- ${line}${agent?.pane ? " [pane]" : ""}`;
								})
								.join("\n"),
							"",
							"Commands: `/agents show <name>`, `/agents start <name>`, `/agents send <name> <task>`, `/agents attach <name>`, `/agents stop <name>`, `/agents status`, `/agents collect`.",
						].join("\n");
					}
				}
			} catch (error) {
				content = `Error: ${error instanceof Error ? error.message : String(error)}`;
			}

			pi.sendMessage({ customType: "subagent-agents", content, display: true });
		},
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (!pi.getActiveTools().includes("subagent")) return;

		const discovery = discoverAgents(ctx.cwd, "project");
		if (discovery.agents.length === 0) return;

		const agentLines = discovery.agents
			.map((agent) => {
				const model = agent.model ? ` model=${agent.model}` : "";
				const tools = agent.tools ? ` tools=${agent.tools.join(",")}` : "";
				const pane = agent.pane ? " pane=true" : "";
				return `- ${agent.name}: ${agent.description} (${agent.source}${model}${tools}${pane})`;
			})
			.join("\n");

		return {
			systemPrompt: `${event.systemPrompt}\n\n## Project Subagents\nUse the \`subagent\` tool when isolated context, specialist review, reconnaissance, planning, or parallel read-only investigation would help. Project-local agents are loaded from .pi/agents, with .claude/agents as a compatibility source. Agents with \`pane=true\` run in persistent tmux panes and can also be managed with \`/agents start|send|attach|stop|status\`. Available project subagents:\n${agentLines}\n\nDefault \`agentScope\` is \"project\". Use \"both\" only when user-level agents are explicitly needed.`,
		};
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			'Default agent scope is "project" (.pi/agents plus .claude/agents compatibility).',
			'Use agentScope: "both" to include user-level agents from ~/.pi/agent/agents.',
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "project";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? false;
			const parentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			const parentThinkingLevel = pi.getThinkingLevel();

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const stepAgent = agents.find((agent) => agent.name === step.agent);
					const result = stepAgent?.pane
						? await runPersistentPaneAgent(
								ctx.cwd,
								agents,
								step.agent,
								taskWithContext,
								step.cwd,
								parentModel,
								parentThinkingLevel,
								i + 1,
							)
						: await runSingleAgent(
								ctx.cwd,
								agents,
								step.agent,
								taskWithContext,
								step.cwd,
								parentModel,
								parentThinkingLevel,
								i + 1,
								signal,
								chainUpdate,
								makeDetails("chain"),
							);
					results.push(result);

					const isError =
						result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
					if (isError) {
						const errorMsg =
							result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				return {
					content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1, // -1 = still running
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const taskAgent = agents.find((agent) => agent.name === t.agent);
					const result = taskAgent?.pane
						? await runPersistentPaneAgent(
								ctx.cwd,
								agents,
								t.agent,
								t.task,
								t.cwd,
								parentModel,
								parentThinkingLevel,
								undefined,
							)
						: await runSingleAgent(
								ctx.cwd,
								agents,
								t.agent,
								t.task,
								t.cwd,
								parentModel,
								parentThinkingLevel,
								undefined,
								signal,
								// Per-task update callback
								(partial) => {
									if (partial.details?.results[0]) {
										allResults[index] = partial.details.results[0];
										emitParallelUpdate();
									}
								},
								makeDetails("parallel"),
							);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => r.exitCode === 0).length;
				const summaries = results.map((r) => {
					const output = getFinalOutput(r.messages);
					const preview = output.slice(0, 100) + (output.length > 100 ? "..." : "");
					return `[${r.agent}] ${r.exitCode === 0 ? "completed" : "failed"}: ${preview || "(no output)"}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			if (params.agent && params.task) {
				const agent = agents.find((candidate) => candidate.name === params.agent);
				const result = agent?.pane
					? await runPersistentPaneAgent(
							ctx.cwd,
							agents,
							params.agent,
							params.task,
							params.cwd,
							parentModel,
							parentThinkingLevel,
							undefined,
						)
					: await runSingleAgent(
							ctx.cwd,
							agents,
							params.agent,
							params.task,
							params.cwd,
							parentModel,
							parentThinkingLevel,
							undefined,
							signal,
							onUpdate,
							makeDetails("single"),
						);
				const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
				if (isError) {
					const errorMsg =
						result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const failCount = details.results.filter((r) => r.exitCode > 0).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: r.exitCode === 0
								? theme.fg("success", "✓")
								: theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}
