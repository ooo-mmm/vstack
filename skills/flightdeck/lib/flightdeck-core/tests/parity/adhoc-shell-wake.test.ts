// Regression coverage for vstack#85 (Fix A): adhoc shell entries whose
// tmux pane has vanished must transition to `complete` and emit
// `entry.completed` during reconcile. Shell harnesses have no idle
// subscriber, so pane-gone is the only meaningful terminal signal.

import { describe, expect, test } from "bun:test";

import {
	TERMINAL_STATES,
	decideShellAdhocWake,
} from "../../src/daemon/shell-adhoc-wake.ts";

describe("decideShellAdhocWake (vstack#85 Fix A)", () => {
	test("adhoc shell entry with gone pane -> transition to complete", () => {
		const outcome = decideShellAdhocWake({
			kind: "adhoc",
			harness: "shell",
			state: "waiting",
			paneAlive: false,
		});
		expect(outcome.transition).toBe(true);
		if (!outcome.transition) throw new Error("expected transition=true");
		expect(outcome.nextState).toBe("complete");
	});

	test("adhoc shell entry with live pane -> no transition (pane-alive)", () => {
		const outcome = decideShellAdhocWake({
			kind: "adhoc",
			harness: "shell",
			state: "waiting",
			paneAlive: true,
		});
		expect(outcome.transition).toBe(false);
		if (outcome.transition) throw new Error("expected transition=false");
		expect(outcome.reason).toBe("pane-alive");
	});

	test("issue-kind shell entry with gone pane -> no transition (not-adhoc)", () => {
		const outcome = decideShellAdhocWake({
			kind: "issue",
			harness: "shell",
			state: "waiting",
			paneAlive: false,
		});
		expect(outcome.transition).toBe(false);
		if (outcome.transition) throw new Error("expected transition=false");
		expect(outcome.reason).toBe("not-adhoc");
	});

	test("workflow-kind shell entry with gone pane -> no transition (not-adhoc)", () => {
		const outcome = decideShellAdhocWake({
			kind: "workflow",
			harness: "shell",
			state: "waiting",
			paneAlive: false,
		});
		expect(outcome.transition).toBe(false);
		if (outcome.transition) throw new Error("expected transition=false");
		expect(outcome.reason).toBe("not-adhoc");
	});

	test("adhoc pi entry with gone pane -> no transition (not-shell, pi has its own wake path)", () => {
		const outcome = decideShellAdhocWake({
			kind: "adhoc",
			harness: "pi",
			state: "waiting",
			paneAlive: false,
		});
		expect(outcome.transition).toBe(false);
		if (outcome.transition) throw new Error("expected transition=false");
		expect(outcome.reason).toBe("not-shell");
	});

	test("adhoc claude/opencode/codex with gone pane -> no transition (not-shell)", () => {
		for (const harness of ["claude", "opencode", "codex"]) {
			const outcome = decideShellAdhocWake({
				kind: "adhoc",
				harness,
				state: "waiting",
				paneAlive: false,
			});
			expect(outcome.transition).toBe(false);
			if (outcome.transition) throw new Error("expected transition=false");
			expect(outcome.reason).toBe("not-shell");
		}
	});

	test("idempotency: already-terminal state -> no transition", () => {
		for (const terminal of TERMINAL_STATES) {
			const outcome = decideShellAdhocWake({
				kind: "adhoc",
				harness: "shell",
				state: terminal,
				paneAlive: false,
			});
			expect(outcome.transition).toBe(false);
			if (outcome.transition) throw new Error(`expected transition=false for state=${terminal}`);
			expect(outcome.reason).toBe("already-terminal");
		}
	});

	test("case-insensitive kind/harness matching", () => {
		const outcome = decideShellAdhocWake({
			kind: "ADHOC",
			harness: "Shell",
			state: "WAITING",
			paneAlive: false,
		});
		expect(outcome.transition).toBe(true);
		if (!outcome.transition) throw new Error("expected transition=true");
		expect(outcome.nextState).toBe("complete");
	});

	test("non-waiting non-terminal states still transition (e.g. prompting / ready)", () => {
		for (const state of ["prompting", "submitting", "ready", "merge-ready"]) {
			const outcome = decideShellAdhocWake({
				kind: "adhoc",
				harness: "shell",
				state,
				paneAlive: false,
			});
			expect(outcome.transition).toBe(true);
			if (!outcome.transition) throw new Error(`expected transition=true for state=${state}`);
			expect(outcome.nextState).toBe("complete");
		}
	});

	test("empty/missing state with gone pane -> transition (treat empty as non-terminal)", () => {
		const outcome = decideShellAdhocWake({
			kind: "adhoc",
			harness: "shell",
			state: "",
			paneAlive: false,
		});
		expect(outcome.transition).toBe(true);
		if (!outcome.transition) throw new Error("expected transition=true");
		expect(outcome.nextState).toBe("complete");
	});

	test("TERMINAL_STATES export matches the documented vocabulary", () => {
		expect([...TERMINAL_STATES].sort()).toEqual(["aborted", "cancelled", "complete", "dead", "merged"]);
	});

	test("vstack#95C: terminal_emitted_at marker suppresses re-emit after manual state reset", () => {
		const outcome = decideShellAdhocWake({
			kind: "adhoc",
			harness: "shell",
			state: "waiting",
			paneAlive: false,
			terminalEmittedAt: "2026-05-15T10:10:00Z",
		});
		expect(outcome.transition).toBe(false);
		if (outcome.transition) throw new Error("expected transition=false");
		expect(outcome.reason).toBe("marker-present");
	});

	test("vstack#95C: cleared marker re-enables a fresh emit (operator override path)", () => {
		for (const marker of [null, undefined, "", "   "]) {
			const outcome = decideShellAdhocWake({
				kind: "adhoc",
				harness: "shell",
				state: "waiting",
				paneAlive: false,
				terminalEmittedAt: marker,
			});
			expect(outcome.transition).toBe(true);
			if (!outcome.transition) throw new Error(`expected transition=true for marker=${String(marker)}`);
			expect(outcome.nextState).toBe("complete");
		}
	});

	test("vstack#95C: marker on already-terminal state still skips with already-terminal precedence", () => {
		const outcome = decideShellAdhocWake({
			kind: "adhoc",
			harness: "shell",
			state: "complete",
			paneAlive: false,
			terminalEmittedAt: "2026-05-15T10:10:00Z",
		});
		expect(outcome.transition).toBe(false);
		if (outcome.transition) throw new Error("expected transition=false");
		expect(outcome.reason).toBe("already-terminal");
	});
});
