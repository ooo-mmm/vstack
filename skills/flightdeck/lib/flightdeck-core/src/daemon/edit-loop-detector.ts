// Post-compaction edit-loop detector (vstack#67 workaround).
//
// Upstream pi-coding-agent has a bug where, after auto-compaction, the
// agent retries the `edit` tool and every call returns
// `Validation failed for tool "edit":`. The agent loops indefinitely
// instead of surfacing the failure. The W5 agent-end watchdog only
// fires on `agent_end`; the stalled-idle watchdog (vstack#63) only
// fires when the pane is idle. An actively-erroring agent is neither
// idle nor done, so neither watchdog catches it.
//
// This detector watches per-pane consecutive `tool_execution_error`
// events tagged with `tool_name == "edit"`. After N errors inside an
// M-second window it returns "fire" exactly once per pane so the
// caller can emit a synthetic `blocked` outbox row. The state Map is
// trimmed to the last N entries so memory stays bounded.
//
// Production wiring (subscribers.bash pi_subscriber_loop) emits a
// `pi-edit-tool-loop` wake-event row to WAKE_EVENTS_LOG when the bash
// mirror crosses the threshold; the daemon's canonical-tag path then
// wakes master. There is no TS-side synthetic outbox writer; the bash
// emit IS the production path.
//
// Configuration via env vars (read by the caller, not by this module):
//   VSTACK_EDIT_LOOP_DETECTOR=0     disables the detector entirely.
//   VSTACK_EDIT_LOOP_THRESHOLD_N    consecutive failures gate (default 5).
//   VSTACK_EDIT_LOOP_WINDOW_SEC     time window in seconds (default 120).

export const EDIT_LOOP_REASON = "post-compaction-edit-loop" as const;
export const EDIT_LOOP_CLASSIFIER_TAG = "pi-edit-tool-loop" as const;
export const EDIT_LOOP_DEFAULT_THRESHOLD_N = 5;
export const EDIT_LOOP_DEFAULT_WINDOW_SEC = 120;

export interface EditLoopEvent {
	paneId: string;
	toolName: string;
	timestampMs: number;
}

export interface EditLoopState {
	/** Per-pane sliding window of recent edit-error timestamps (ms). */
	timestamps: Map<string, number[]>;
	/** Panes that have already fired during the current run. */
	fired: Set<string>;
}

export type EditLoopDecision = "fire" | "track" | "skip" | "disabled" | "not-edit";

export interface EditLoopConfig {
	thresholdN: number;
	windowMs: number;
	enabled: boolean;
}

export const DEFAULT_EDIT_LOOP_CONFIG: EditLoopConfig = {
	thresholdN: EDIT_LOOP_DEFAULT_THRESHOLD_N,
	windowMs: EDIT_LOOP_DEFAULT_WINDOW_SEC * 1000,
	enabled: true,
};

export function makeEditLoopState(): EditLoopState {
	return { timestamps: new Map(), fired: new Set() };
}

/**
 * Evaluate whether a new edit-tool error event should fire a synthetic
 * blocked wake. Returns:
 *   - "disabled" when the config gate is off.
 *   - "not-edit" when the event's toolName isn't 'edit'.
 *   - "skip" when this pane already fired since reset (idempotency).
 *   - "track" when the event was recorded but the threshold isn't met.
 *   - "fire" when N events occurred within the rolling window. The
 *     caller must emit a synthetic outbox and call resetPane(paneId)
 *     when ready to re-arm.
 */
export function evaluateEditLoop(
	state: EditLoopState,
	event: EditLoopEvent,
	config: EditLoopConfig = DEFAULT_EDIT_LOOP_CONFIG,
): EditLoopDecision {
	if (!config.enabled) return "disabled";
	if (!event.paneId) return "skip";
	if (event.toolName !== "edit") return "not-edit";
	if (state.fired.has(event.paneId)) return "skip";

	const cutoff = event.timestampMs - config.windowMs;
	const existing = state.timestamps.get(event.paneId) ?? [];
	const pruned = existing.filter((ts) => ts >= cutoff);
	pruned.push(event.timestampMs);
	// Trim to the most recent thresholdN entries so memory stays bounded.
	if (pruned.length > config.thresholdN) pruned.splice(0, pruned.length - config.thresholdN);
	state.timestamps.set(event.paneId, pruned);

	if (pruned.length >= config.thresholdN && pruned[0]! >= cutoff) {
		state.fired.add(event.paneId);
		return "fire";
	}
	return "track";
}

export function resetEditLoopPane(state: EditLoopState, paneId: string): void {
	state.timestamps.delete(paneId);
	state.fired.delete(paneId);
}

export function editLoopDetectorEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = env.VSTACK_EDIT_LOOP_DETECTOR?.trim();
	if (raw === undefined || raw === "") return true;
	return raw !== "0" && raw.toLowerCase() !== "false" && raw.toLowerCase() !== "off";
}

export function editLoopThresholdFromEnv(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.VSTACK_EDIT_LOOP_THRESHOLD_N?.trim();
	const parsed = raw ? Number(raw) : Number.NaN;
	if (!Number.isFinite(parsed) || parsed < 1) return EDIT_LOOP_DEFAULT_THRESHOLD_N;
	return Math.floor(parsed);
}

export function editLoopWindowMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.VSTACK_EDIT_LOOP_WINDOW_SEC?.trim();
	const parsed = raw ? Number(raw) : Number.NaN;
	if (!Number.isFinite(parsed) || parsed < 1) return EDIT_LOOP_DEFAULT_WINDOW_SEC * 1000;
	return Math.floor(parsed * 1000);
}

export function editLoopConfigFromEnv(env: NodeJS.ProcessEnv = process.env): EditLoopConfig {
	return {
		enabled: editLoopDetectorEnabledFromEnv(env),
		thresholdN: editLoopThresholdFromEnv(env),
		windowMs: editLoopWindowMsFromEnv(env),
	};
}
