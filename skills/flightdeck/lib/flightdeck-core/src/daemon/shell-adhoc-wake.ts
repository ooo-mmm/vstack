// Adhoc shell pane-gone → terminal-state-reached decision (vstack#85).
//
// Shell harnesses have NO idle subscriber (unlike pi/claude/opencode/codex),
// so the W5 G1 pattern in pi-adhoc-wake.ts (which gates on
// `isIdle: true && hasPendingMessages: false`) does not apply. For adhoc
// shell entries the only meaningful terminal signal is "the user's tmux
// pane is gone" — once the pane is destroyed the session is, by
// definition, done. Without this gate adhoc-shell entries stay stuck in
// `waiting` forever and the dashboard/session-watch never advance them
// to `complete`.
//
// This module owns the pure decision so:
//   - The runtime caller (`bin/pane-registry.ts::cmdReconcile`) stays a
//     thin shell-out + state writer; the gating logic and exhaustive
//     cases live in unit tests against this function.
//   - The decision composes with the existing reconcile drop-on-gone
//     path: shell-adhoc gets a success transition + `entry.completed`,
//     while non-shell-adhoc entries keep the legacy drop + `entry.dead`
//     warning emit.

/** Terminal lifecycle states across both adhoc and issue-mode wires. */
export const TERMINAL_STATES = new Set([
	"merged",
	"aborted",
	"dead",
	"complete",
	"cancelled",
]);

export interface ShellAdhocWakeInput {
	/** `.entries[].kind` — adhoc | issue | workflow */
	kind: string;
	/** `.entries[].harness` — pi | claude | opencode | codex | shell */
	harness: string;
	/** `.entries[].state` — waiting | prompting | ... | complete | cancelled | dead */
	state: string;
	/** True iff the registered `pane_id` is still in `tmux list-panes -a`. */
	paneAlive: boolean;
	/**
	 * `.entries[].terminal_emitted_at` — ISO8601 marker recorded on the
	 * first synthetic terminal-state transition. Suppresses re-emission
	 * when an operator resets state back from a terminal value
	 * (vstack#95C); operators wanting a fresh emit must clear the marker
	 * explicitly.
	 */
	terminalEmittedAt?: string | null;
}

export interface ShellAdhocWakeSkip {
	transition: false;
	reason:
		| "pane-alive"
		| "not-adhoc"
		| "not-shell"
		| "already-terminal"
		| "marker-present";
}

export interface ShellAdhocWakeTransition {
	transition: true;
	nextState: "complete";
}

export type ShellAdhocWakeOutcome = ShellAdhocWakeSkip | ShellAdhocWakeTransition;

/**
 * Decide whether an adhoc shell entry whose pane has vanished should be
 * transitioned to `complete` (and have `entry.completed` emitted).
 *
 * Returns `transition: true` only when:
 *   - pane is gone (`paneAlive === false`)
 *   - kind is exactly "adhoc" (case-insensitive)
 *   - harness is exactly "shell" (case-insensitive)
 *   - current state is not already terminal (idempotency for the
 *     normal terminal-state path)
 *   - `terminal_emitted_at` marker is absent (vstack#95C idempotency:
 *     if a prior tick already emitted entry.completed for this entry,
 *     a manual reset to a non-terminal state must NOT re-trigger the
 *     synthetic emit. Operator surgery wanting a fresh emit can clear
 *     the marker explicitly.)
 *
 * All other cases skip with a reason string for diagnostics.
 */
export function decideShellAdhocWake(input: ShellAdhocWakeInput): ShellAdhocWakeOutcome {
	if (input.paneAlive) return { transition: false, reason: "pane-alive" };
	const kind = (input.kind ?? "").trim().toLowerCase();
	const harness = (input.harness ?? "").trim().toLowerCase();
	const state = (input.state ?? "").trim().toLowerCase();
	if (kind !== "adhoc") return { transition: false, reason: "not-adhoc" };
	if (harness !== "shell") return { transition: false, reason: "not-shell" };
	if (TERMINAL_STATES.has(state)) return { transition: false, reason: "already-terminal" };
	if (typeof input.terminalEmittedAt === "string" && input.terminalEmittedAt.trim()) {
		return { transition: false, reason: "marker-present" };
	}
	return { transition: true, nextState: "complete" };
}
