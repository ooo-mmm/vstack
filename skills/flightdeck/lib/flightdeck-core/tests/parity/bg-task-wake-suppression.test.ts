// Regression coverage for vstack#69: the daemon must respect the
// notifyOnExit and notifyMode hints in the pi-background-tasks payload
// so engineer-scaffolding tasks (smoke tests, daemon mocks spawned with
// notifyOnExit:false or notifyMode:first-match-only) stop waking master
// on clean exits. Real terminal-state events still wake.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { shouldEmitBgTaskExitWake } from "../../src/daemon/wake-filter.ts";

describe("shouldEmitBgTaskExitWake (vstack#69)", () => {
	test("notifyOnExit:false -> drop with notify-exit-disabled reason", () => {
		const decision = shouldEmitBgTaskExitWake({ task: { notifyOnExit: false, status: "completed", exitCode: 0 } });
		expect(decision.emit).toBe(false);
		if (!decision.emit) expect(decision.reason).toBe("notify-exit-disabled");
	});

	test("notifyOnExit:true (default) -> emit", () => {
		expect(shouldEmitBgTaskExitWake({ task: { notifyOnExit: true, status: "completed", exitCode: 0 } }).emit).toBe(true);
	});

	test("notifyOnExit unset -> emit (default behavior preserved)", () => {
		expect(shouldEmitBgTaskExitWake({ task: { status: "completed", exitCode: 0 } }).emit).toBe(true);
	});

	test("notifyMode:first-match-only + status:completed + exitCode:0 -> drop", () => {
		const decision = shouldEmitBgTaskExitWake({
			task: { notifyMode: "first-match-only", status: "completed", exitCode: 0 },
		});
		expect(decision.emit).toBe(false);
		if (!decision.emit) expect(decision.reason).toBe("first-match-only-clean-exit");
	});

	test("notifyMode:first-match-only + status:failed -> emit (failure still wakes)", () => {
		expect(shouldEmitBgTaskExitWake({
			task: { notifyMode: "first-match-only", status: "failed", exitCode: 1 },
		}).emit).toBe(true);
	});

	test("notifyMode:first-match-only + status:completed + non-zero exit -> emit", () => {
		// exitCode != 0 means the task reported clean status but a non-zero exit;
		// surface it so the agent sees the contradiction.
		expect(shouldEmitBgTaskExitWake({
			task: { notifyMode: "first-match-only", status: "completed", exitCode: 2 },
		}).emit).toBe(true);
	});

	test("notifyMode:always (default) + status:completed -> emit", () => {
		expect(shouldEmitBgTaskExitWake({
			task: { notifyMode: "always", status: "completed", exitCode: 0 },
		}).emit).toBe(true);
	});

	test("notifyMode:transition + status:completed -> emit (only first-match-only clean exit is suppressed)", () => {
		expect(shouldEmitBgTaskExitWake({
			task: { notifyMode: "transition", status: "completed", exitCode: 0 },
		}).emit).toBe(true);
	});

	test("missing task payload -> emit (defensive default; subscriber path is the source of truth)", () => {
		expect(shouldEmitBgTaskExitWake({}).emit).toBe(true);
		expect(shouldEmitBgTaskExitWake({ task: null }).emit).toBe(true);
	});

	test("notifyOnExit:false overrides everything else", () => {
		expect(shouldEmitBgTaskExitWake({
			task: { notifyOnExit: false, notifyMode: "always", status: "failed", exitCode: 1 },
		}).emit).toBe(false);
	});
});

describe("loop.ts drain branch wires bg-task suppression (vstack#69)", () => {
	const loopSrc = readFileSync(new URL("../../src/daemon/loop.ts", import.meta.url), "utf8");

	test("imports shouldEmitBgTaskExitWake", () => {
		expect(loopSrc).toContain("shouldEmitBgTaskExitWake");
	});

	test("checks the bg-task wake decision before appendEvent", () => {
		const filterIdx = loopSrc.indexOf("shouldEmitBgTaskExitWake({");
		const adapterAppendIdx = loopSrc.indexOf("`adapter:${evPid}:${evTag}`");
		expect(filterIdx).toBeGreaterThan(-1);
		expect(adapterAppendIdx).toBeGreaterThan(-1);
		expect(filterIdx).toBeLessThan(adapterAppendIdx);
	});

	test("logs bg-task-drop on suppression", () => {
		expect(loopSrc).toContain("bg-task-drop");
	});

	test("sets notifiedHash on suppression so the same event does not re-fire next tick", () => {
		const drop = loopSrc.match(/bg-task-drop[\s\S]{0,400}notifiedHash\.set/);
		expect(drop).not.toBeNull();
	});
});
