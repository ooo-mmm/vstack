import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const INSTALL_SYMBOL = Symbol.for("vstack.pi-tool-renderer.installed");

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
			const config = parsed?.vstack?.extensionManager?.config?.["pi-tool-renderer"];
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

function lineCount(text: string): number {
	if (!text) return 0;
	return text.split(/\r?\n/).length;
}

function textContent(result: any): string {
	const part = result?.content?.find?.((candidate: any) => candidate?.type === "text" && typeof candidate.text === "string");
	return part?.text ?? "";
}

function clipLine(line: string, cwd?: string): string {
	const max = Math.max(40, Math.floor(settingNumber("maxLineWidth", 180, cwd)));
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function preview(text: string, count: number, direction: "head" | "tail", cwd?: string): string {
	const lines = text.split(/\r?\n/);
	const selected = direction === "head" ? lines.slice(0, count) : lines.slice(-count);
	return selected.map((line) => clipLine(line, cwd)).join("\n");
}

function commandExit(text: string): number | null {
	const match = text.match(/exit code:\s*(\d+)/i) ?? text.match(/exit\s+(\d+)/i);
	return match ? Number.parseInt(match[1]!, 10) : null;
}

function diffStats(diff: string): { additions: number; removals: number } {
	let additions = 0;
	let removals = 0;
	for (const line of diff.split(/\r?\n/)) {
		if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
		if (line.startsWith("-") && !line.startsWith("---")) removals += 1;
	}
	return { additions, removals };
}

function truncatedMarker(text: string): boolean {
	return /truncated|Full output|Output truncated/i.test(text);
}

function makeText(text: string): Text {
	return new Text(text, 0, 0);
}

function registerRead(pi: ExtensionAPI, agent: any, cwd: string): void {
	const original = agent.createReadTool?.(cwd);
	if (!original) return;
	pi.registerTool({
		name: "read",
		label: "read",
		description: original.description,
		parameters: original.parameters,
		async execute(id: string, params: any, signal: AbortSignal | undefined, onUpdate: unknown) {
			return original.execute(id, params, signal, onUpdate);
		},
		renderCall(args: any, theme: any) {
			const range = args.offset || args.limit ? `:${args.offset ?? 1}${args.limit ? `-${Number(args.offset ?? 1) + Number(args.limit) - 1}` : ""}` : "";
			return makeText(`${theme.fg("toolTitle", theme.bold("Read "))}${theme.fg("accent", `${args.path}${range}`)}`);
		},
		renderResult(result: any, { expanded, isPartial }: any, theme: any, context: any) {
			if (isPartial) return makeText(theme.fg("warning", "Reading…"));
			const content = textContent(result);
			const count = lineCount(content);
			let text = theme.fg("success", `${count} line${count === 1 ? "" : "s"}`);
			if (truncatedMarker(content)) text += theme.fg("warning", " · truncated");
			if (expanded && content) {
				const limit = Math.max(1, Math.floor(settingNumber("readPreviewLines", 80, context?.cwd)));
				text += `\n${theme.fg("dim", preview(content, limit, "head", context?.cwd))}`;
				if (count > limit) text += `\n${theme.fg("muted", `… ${count - limit} more line(s)`)}`;
			}
			return makeText(text);
		},
	});
}

function registerBash(pi: ExtensionAPI, agent: any, cwd: string): void {
	const original = agent.createBashTool?.(cwd);
	if (!original) return;
	pi.registerTool({
		name: "bash",
		label: "bash",
		description: original.description,
		parameters: original.parameters,
		async execute(id: string, params: any, signal: AbortSignal | undefined, onUpdate: unknown) {
			return original.execute(id, params, signal, onUpdate);
		},
		renderCall(args: any, theme: any, context: any) {
			const max = Math.max(20, Math.floor(settingNumber("commandPreviewChars", 96, context?.cwd)));
			const command = args.command && args.command.length > max ? `${args.command.slice(0, max - 1)}…` : args.command;
			return makeText(`${theme.fg("toolTitle", theme.bold("Bash $ "))}${theme.fg("accent", command ?? "")}`);
		},
		renderResult(result: any, { expanded, isPartial }: any, theme: any, context: any) {
			if (isPartial) return makeText(theme.fg("warning", "Running…"));
			const output = textContent(result);
			const exit = commandExit(output);
			const count = lineCount(output);
			let text = exit && exit !== 0 ? theme.fg("error", `exit ${exit}`) : theme.fg("success", "done");
			text += theme.fg("dim", ` · ${count} line${count === 1 ? "" : "s"}`);
			if (truncatedMarker(output)) text += theme.fg("warning", " · truncated");
			if (expanded && output) {
				const limit = Math.max(1, Math.floor(settingNumber("bashPreviewLines", 80, context?.cwd)));
				text += `\n${theme.fg("dim", preview(output, limit, "tail", context?.cwd))}`;
				if (count > limit) text += `\n${theme.fg("muted", `… ${count - limit} older line(s)`)}`;
			}
			return makeText(text);
		},
	});
}

function registerEdit(pi: ExtensionAPI, agent: any, cwd: string): void {
	const original = agent.createEditTool?.(cwd);
	if (!original) return;
	pi.registerTool({
		name: "edit",
		label: "edit",
		description: original.description,
		parameters: original.parameters,
		async execute(id: string, params: any, signal: AbortSignal | undefined, onUpdate: unknown) {
			return original.execute(id, params, signal, onUpdate);
		},
		renderCall(args: any, theme: any) {
			return makeText(`${theme.fg("toolTitle", theme.bold("Edit "))}${theme.fg("accent", args.path ?? "")}`);
		},
		renderResult(result: any, { expanded, isPartial }: any, theme: any, context: any) {
			if (isPartial) return makeText(theme.fg("warning", "Editing…"));
			const diff = result?.details?.diff ?? "";
			const stats = diffStats(diff);
			let text = `${theme.fg("success", `+${stats.additions}`)} ${theme.fg("error", `-${stats.removals}`)}`;
			if (!diff) text = theme.fg("success", "applied");
			if (expanded && diff) {
				const limit = Math.max(1, Math.floor(settingNumber("editPreviewLines", 120, context?.cwd)));
				text += `\n${preview(diff, limit, "head", context?.cwd)}`;
				const count = lineCount(diff);
				if (count > limit) text += `\n${theme.fg("muted", `… ${count - limit} more diff line(s)`)}`;
			}
			return makeText(text);
		},
	});
}

function registerWrite(pi: ExtensionAPI, agent: any, cwd: string): void {
	const original = agent.createWriteTool?.(cwd);
	if (!original) return;
	pi.registerTool({
		name: "write",
		label: "write",
		description: original.description,
		parameters: original.parameters,
		async execute(id: string, params: any, signal: AbortSignal | undefined, onUpdate: unknown) {
			return original.execute(id, params, signal, onUpdate);
		},
		renderCall(args: any, theme: any) {
			const count = lineCount(args.content ?? "");
			return makeText(`${theme.fg("toolTitle", theme.bold("Write "))}${theme.fg("accent", args.path ?? "")} ${theme.fg("dim", `· ${count} lines`)}`);
		},
		renderResult(result: any, { expanded, isPartial }: any, theme: any, context: any) {
			if (isPartial) return makeText(theme.fg("warning", "Writing…"));
			let text = theme.fg("success", "written");
			const args = context?.args ?? {};
			const content = args.content ?? textContent(result);
			if (expanded && content) {
				const limit = Math.max(1, Math.floor(settingNumber("writePreviewLines", 80, context?.cwd)));
				text += `\n${theme.fg("dim", preview(content, limit, "head", context?.cwd))}`;
				const count = lineCount(content);
				if (count > limit) text += `\n${theme.fg("muted", `… ${count - limit} more line(s)`)}`;
			}
			return makeText(text);
		},
	});
}

function registerReadOnly(pi: ExtensionAPI, agent: any, cwd: string, toolName: "grep" | "find" | "ls", factoryName: string): void {
	const original = agent[factoryName]?.(cwd);
	if (!original) return;
	pi.registerTool({
		name: toolName,
		label: toolName,
		description: original.description,
		parameters: original.parameters,
		async execute(id: string, params: any, signal: AbortSignal | undefined, onUpdate: unknown) {
			return original.execute(id, params, signal, onUpdate);
		},
		renderCall(args: any, theme: any) {
			const query = args.pattern ?? args.glob ?? args.path ?? args.query ?? "";
			return makeText(`${theme.fg("toolTitle", theme.bold(`${toolName} `))}${theme.fg("accent", clipLine(String(query)))}`);
		},
		renderResult(result: any, { expanded, isPartial }: any, theme: any, context: any) {
			if (isPartial) return makeText(theme.fg("warning", `${toolName}…`));
			const output = textContent(result);
			const count = output.trim() ? lineCount(output) : 0;
			let text = theme.fg("success", `${count} result${count === 1 ? "" : "s"}`);
			if (truncatedMarker(output)) text += theme.fg("warning", " · truncated");
			if (expanded && output) {
				const limit = Math.max(1, Math.floor(settingNumber("searchPreviewLines", 80, context?.cwd)));
				text += `\n${theme.fg("dim", preview(output, limit, "head", context?.cwd))}`;
				if (count > limit) text += `\n${theme.fg("muted", `… ${count - limit} more result line(s)`)}`;
			}
			return makeText(text);
		},
	});
}

export default async function toolRenderer(pi: ExtensionAPI): Promise<void> {
	const guard = pi as unknown as Record<PropertyKey, unknown>;
	if (guard[INSTALL_SYMBOL]) return;
	guard[INSTALL_SYMBOL] = true;
	if (!settingBoolean("enabled", true)) return;

	const agent = await import("@mariozechner/pi-coding-agent");
	const cwd = process.cwd();
	registerRead(pi, agent, cwd);
	registerBash(pi, agent, cwd);
	registerEdit(pi, agent, cwd);
	registerWrite(pi, agent, cwd);
	registerReadOnly(pi, agent, cwd, "grep", "createGrepTool");
	registerReadOnly(pi, agent, cwd, "find", "createFindTool");
	registerReadOnly(pi, agent, cwd, "ls", "createLsTool");
}
