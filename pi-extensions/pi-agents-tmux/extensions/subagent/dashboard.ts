import * as path from "node:path";
import { type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	ansiMagenta,
	formatUsageStatsForDashboard,
	oneLinePreview,
	padAnsi,
	simpleFrame,
	subagentBranch,
	subagentStem,
} from "./format.js";
import {
	dashboardEnabled,
	dashboardMaxItems,
	dashboardShortcut,
	formatShortcutHint,
	popupShortcut,
} from "./settings.js";
import {
	type DashboardKind,
	ICONS,
	PACKAGE_ID,
	type PaneTaskStatus,
	type SubagentDashboardItem,
	type SubagentDashboardState,
	type UsageStats,
} from "./types.js";

export function dashboardKindLabel(kind: DashboardKind): string {
	return kind === "oneshot" ? "bg" : kind;
}

export function dashboardStatusFor(rawStatus: PaneTaskStatus | "running" | "waiting", _kind: DashboardKind): SubagentDashboardItem["status"] {
	// Persistent panes stay alive after each task, but the dashboard should reflect
	// the latest task lifecycle. A later queued/running record for the same pane
	// replaces this item and moves it back to working.
	return rawStatus;
}

export function isDashboardWorkingStatus(status: SubagentDashboardItem["status"]): boolean {
	return status === "running" || status === "queued" || status === "waiting";
}

export function isDashboardAttentionStatus(status: SubagentDashboardItem["status"]): boolean {
	return status === "failed" || status === "blocked" || status === "needs_completion" || status === "unknown";
}

function dashboardStatusRank(status: SubagentDashboardItem["status"]): number {
	if (isDashboardWorkingStatus(status)) return 0;
	if (isDashboardAttentionStatus(status)) return 1;
	if (status === "completed") return 2;
	return 3;
}

export function sortDashboardItems(items: SubagentDashboardItem[]): SubagentDashboardItem[] {
	return [...items].sort((a, b) => {
		const rank = dashboardStatusRank(a.status) - dashboardStatusRank(b.status);
		if (rank !== 0) return rank;
		const aKey = a.startedAt ?? a.taskId;
		const bKey = b.startedAt ?? b.taskId;
		if (aKey !== bKey) return aKey < bKey ? -1 : 1;
		return a.agent.localeCompare(b.agent) || a.taskId.localeCompare(b.taskId);
	});
}

export function dashboardStatusIcon(status: SubagentDashboardItem["status"], theme: Theme): string {
	if (status === "completed") return theme.fg("success", ICONS.check);
	if (status === "failed") return theme.fg("error", ICONS.times);
	if (status === "blocked") return theme.fg("error", ICONS.times);
	if (status === "needs_completion") return theme.fg("warning", ICONS.warning);
	if (status === "running") return theme.fg("warning", ICONS.cog);
	if (status === "waiting") return theme.fg("warning", ICONS.clock);
	if (status === "queued") return theme.fg("warning", ICONS.clock);
	if (status === "unknown") return theme.fg("warning", ICONS.warning);
	return theme.fg("accent", ICONS.circleFilled);
}

export function dashboardStatusText(item: SubagentDashboardItem, theme: Theme): string {
	if (item.status === "completed") return theme.fg("success", "completed");
	if (item.status === "failed") return theme.fg("error", "failed");
	if (item.status === "blocked") return theme.fg("warning", "blocked");
	if (item.status === "needs_completion") return theme.fg("warning", "needs completion");
	if (item.status === "running") return theme.fg("warning", "working");
	if (item.status === "waiting") return theme.fg("warning", "waiting");
	if (item.status === "queued") return theme.fg("warning", "queued");
	if (item.status === "unknown") return theme.fg("warning", "stale");
	return theme.fg("accent", item.status);
}

function dashboardFrame(lines: string[], width: number, theme: Theme): string[] {
	return simpleFrame(lines, width, theme);
}

export function shortRuntimeSessionIdFromPath(filePath: string | undefined): string {
	if (!filePath) return "session";
	const parts = path.normalize(filePath).split(path.sep).filter(Boolean);
	const rootIndex = parts.lastIndexOf(PACKAGE_ID);
	const sessionsIndex = rootIndex >= 0 ? parts.indexOf("sessions", rootIndex + 1) : parts.lastIndexOf("sessions");
	const parentSession = sessionsIndex >= 0 ? parts[sessionsIndex + 1] : undefined;
	return parentSession ? oneLinePreview(parentSession, 8) : "session";
}

export function shortTaskRef(taskId: string | undefined): string {
	if (!taskId) return "task";
	const hash = taskId.match(/-([a-f0-9]{8,})$/)?.[1]?.slice(0, 8);
	const timestamp = taskId.match(/-(\d{10,})-/)?.[1];
	return hash ? `${timestamp ? `${timestamp.slice(-6)}-` : ""}${hash}` : oneLinePreview(taskId, 16);
}

export function dashboardTraceRef(item: Pick<SubagentDashboardItem, "agent" | "taskId" | "transcriptPath" | "kind">): string {
	const session = shortRuntimeSessionIdFromPath(item.transcriptPath);
	if (item.kind === "pane") return `${session}/${item.agent}/${shortTaskRef(item.taskId)}`;
	return dashboardTranscriptRef(item.transcriptPath) || `${session}/${item.agent}/${shortTaskRef(item.taskId)}`;
}

export function dashboardTranscriptRef(filePath: string | undefined): string {
	if (!filePath) return "";
	const parts = path.normalize(filePath).split(path.sep).filter(Boolean);
	const rootIndex = parts.lastIndexOf(PACKAGE_ID);
	const sessionsIndex = rootIndex >= 0 ? parts.indexOf("sessions", rootIndex + 1) : parts.lastIndexOf("sessions");
	const parentSession = sessionsIndex >= 0 ? parts[sessionsIndex + 1] : undefined;
	const shortSession = parentSession ? oneLinePreview(parentSession, 8) : "session";
	const runtimeRelative = sessionsIndex >= 0 && parentSession ? parts.slice(sessionsIndex + 2) : [];
	const file = path.basename(filePath, path.extname(filePath));
	if (runtimeRelative[0] === "sessions") return `${shortSession}/${file}`;
	if (runtimeRelative[0] === "transcripts" && runtimeRelative[1]) {
		const hash = file.match(/-([a-f0-9]{8,})$/)?.[1]?.slice(0, 8);
		const timestamp = file.match(/-(\d{10,})-/)?.[1];
		const suffix = hash ? `${timestamp ? `${timestamp.slice(-6)}-` : ""}${hash}` : "";
		return `${shortSession}/${runtimeRelative[1]}${suffix ? `/${suffix}` : ""}`;
	}
	return `${shortSession}/${file}`;
}

export function dashboardTranscriptLabel(items: SubagentDashboardItem[], cwd: string): string {
	const refs = [...new Set(items.map((item) => dashboardTraceRef(item)).filter(Boolean))];
	void cwd;
	if (refs.length === 0) return "transcripts available";
	if (refs.length === 1) return `transcript ${refs[0]}`;
	const sessionRefs = [...new Set(refs.map((ref) => ref.split("/")[0]).filter(Boolean))];
	if (sessionRefs.length === 1) return `${refs.length} transcripts · session ${sessionRefs[0]}`;
	return `${refs.length} transcripts · ${refs[0]} +${refs.length - 1}`;
}

// Disambiguate repeat bg launches: the 2nd "reviewer-arch" of the session
// renders as "reviewer-arch 2" so two rows with the same agent name aren't
// indistinguishable. Uses taskId for identity and start-time for occurrence
// order; mirrors browser.ts dashboardDisplayLabels.
function dashboardLabelsForItems(items: SubagentDashboardItem[]): Map<string, string> {
	const total = new Map<string, number>();
	for (const item of items) total.set(item.agent, (total.get(item.agent) ?? 0) + 1);
	const occurrence = new Map<string, number>();
	const labels = new Map<string, string>();
	const stable = [...items].sort((a, b) => {
		const aKey = a.startedAt ?? a.taskId;
		const bKey = b.startedAt ?? b.taskId;
		if (aKey !== bKey) return aKey < bKey ? -1 : 1;
		return a.agent.localeCompare(b.agent) || a.taskId.localeCompare(b.taskId);
	});
	for (const item of stable) {
		const next = (occurrence.get(item.agent) ?? 0) + 1;
		occurrence.set(item.agent, next);
		const label = (total.get(item.agent) ?? 1) > 1 && next > 1 ? `${item.agent} ${next}` : item.agent;
		labels.set(item.taskId, label);
	}
	return labels;
}

export function renderDashboardWidgetLines(state: SubagentDashboardState, theme: Theme, cwd: string, width: number): string[] {
	const items = sortDashboardItems(Object.values(state.items));
	const displayLabels = dashboardLabelsForItems(items);
	if (!dashboardEnabled(cwd) || !state.visible || items.length === 0) return [];
	const working = items.filter((item) => isDashboardWorkingStatus(item.status)).length;
	const done = items.filter((item) => item.status === "completed").length;
	const attention = items.filter((item) => isDashboardAttentionStatus(item.status)).length;
	const shortcut = dashboardShortcut(cwd);
	const popup = popupShortcut(cwd);
	const toggleHint = shortcut === "none" ? "" : theme.fg("dim", ` · ${formatShortcutHint(shortcut)} toggle`);
	const popupHint = popup === "none" ? "" : theme.fg("dim", ` · ${formatShortcutHint(popup)} popup`);
	const hint = `${toggleHint}${popupHint}`;
	const headerParts = [
		theme.fg("success", `${done} completed`),
		theme.fg("warning", `${working} working`),
		attention ? theme.fg("error", `${attention} attention`) : "",
	].filter(Boolean);
	const title = `${theme.fg("customMessageLabel", theme.bold("Agents"))} ${theme.fg("muted", headerParts.join(" · "))}${hint}`;
	const lines = [title];
	const aggregateDashboardUsage = (entries: SubagentDashboardItem[]): UsageStats | undefined => {
		const total: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
		let any = false;
		for (const entry of entries) {
			if (!entry.usage) continue;
			any = true;
			total.input += entry.usage.input || 0;
			total.output += entry.usage.output || 0;
			total.cacheRead += entry.usage.cacheRead || 0;
			total.cacheWrite += entry.usage.cacheWrite || 0;
			total.cost += entry.usage.cost || 0;
			total.contextTokens = Math.max(total.contextTokens, entry.usage.contextTokens || 0);
			total.turns = (total.turns ?? 0) + (entry.usage.turns ?? 0);
		}
		return any ? total : undefined;
	};
	const dotSep = theme.fg("dim", " · ");
	if (working === 0 && state.mode === "compact") {
		const aggregated = aggregateDashboardUsage(items);
		const usageParts = aggregated ? formatUsageStatsForDashboard(aggregated) : [];
		const body = usageParts.length > 0
			? usageParts.map((part) => theme.fg("dim", part)).join(dotSep)
			: theme.fg("dim", `${items.length} transcript${items.length === 1 ? "" : "s"}`);
		lines.push(`${subagentBranch(theme, "└", cwd)}${body}`);
		return dashboardFrame(lines.map((line) => truncateToWidth(line, Math.max(1, width - 4), "")), Math.max(1, width), theme);
	}
	const maxItems = state.mode === "compact" || state.collapsed ? 1 : state.mode === "normal" ? Math.min(3, dashboardMaxItems(cwd)) : dashboardMaxItems(cwd);
	const shown = items.slice(0, maxItems);
	const shownLabels = shown.map((item) => displayLabels.get(item.taskId) ?? item.agent);
	const nameWidth = Math.min(24, Math.max(0, ...shownLabels.map((label) => visibleWidth(label))));
	for (const [index, item] of shown.entries()) {
		const branch = subagentBranch(theme, index === shown.length - 1 && items.length <= shown.length ? "└" : "├", cwd);
		const name = padAnsi(ansiMagenta(theme.bold(shownLabels[index])), nameWidth);
		const rowParts: string[] = [
			dashboardStatusText(item, theme),
			theme.fg("dim", dashboardKindLabel(item.kind)),
		];
		if (item.bridge) rowParts.push(theme.fg("success", "bridge"));
		if (item.usage) {
			for (const part of formatUsageStatsForDashboard(item.usage)) {
				rowParts.push(theme.fg("dim", part));
			}
		}
		lines.push(`${branch}${dashboardStatusIcon(item.status, theme)} ${name}${dotSep}${rowParts.join(dotSep)}`);
		if (state.mode === "expanded" && !state.collapsed && item.message) {
			lines.push(`${subagentStem(theme, index === shown.length - 1 && items.length <= shown.length, cwd)}${theme.fg("toolOutput", oneLinePreview(item.message, Math.max(48, width - 16)))}`);
		}
	}
	const hidden = items.length - shown.length;
	if (hidden > 0) lines.push(`${subagentBranch(theme, "└", cwd)}${theme.fg("muted", `… ${hidden} more · /agents toggle`)}`);
	if (state.mode === "expanded" && !state.collapsed) {
		const aggregated = aggregateDashboardUsage(items);
		if (aggregated) {
			const totalParts = formatUsageStatsForDashboard(aggregated).map((part) => theme.fg("dim", part)).join(dotSep);
			if (totalParts.length > 0) {
				lines.push(`${subagentBranch(theme, "└", cwd)}${theme.fg("dim", "Total")}${dotSep}${totalParts}`);
			}
		}
	}
	return dashboardFrame(lines.map((line) => truncateToWidth(line, Math.max(1, width - 4), "")), Math.max(1, width), theme);
}
