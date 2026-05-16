// vstack#67 workaround regression tests: edit-loop detector fires
// exactly once when N consecutive edit-tool errors fall inside an
// M-second window for the same pane. Synthetic outbox carries
// status:'blocked' (not needs_completion) because the agent is
// actively erroring rather than idle.

import { describe, expect, test } from "bun:test";

import {
	DEFAULT_EDIT_LOOP_CONFIG,
	EDIT_LOOP_DEFAULT_THRESHOLD_N,
	EDIT_LOOP_DEFAULT_WINDOW_SEC,
	EDIT_LOOP_REASON,
	buildEditLoopSyntheticOutbox,
	editLoopConfigFromEnv,
	editLoopDetectorEnabledFromEnv,
	editLoopThresholdFromEnv,
	editLoopWindowMsFromEnv,
	evaluateEditLoop,
	makeEditLoopState,
	resetEditLoopPane,
} from "../../src/daemon/edit-loop-detector.ts";

const PANE = "%17";

function fire(times: number, baseMs = 0, deltaMs = 1000): { decisions: ReturnType<typeof evaluateEditLoop>[]; state: ReturnType<typeof makeEditLoopState> } {
	const state = makeEditLoopState();
	const decisions: ReturnType<typeof evaluateEditLoop>[] = [];
	for (let i = 0; i < times; i += 1) {
		decisions.push(
			evaluateEditLoop(state, {
				paneId: PANE,
				toolName: "edit",
				timestampMs: baseMs + i * deltaMs,
			}),
		);
	}
	return { decisions, state };
}

describe("evaluateEditLoop (vstack#67)", () => {
	test("default config is N=5, M=120s, enabled", () => {
		expect(DEFAULT_EDIT_LOOP_CONFIG.thresholdN).toBe(5);
		expect(DEFAULT_EDIT_LOOP_CONFIG.windowMs).toBe(120_000);
		expect(DEFAULT_EDIT_LOOP_CONFIG.enabled).toBe(true);
	});

	test("5 errors in 120s -> fires on the 5th", () => {
		const { decisions } = fire(5, 0, 10_000); // 5 errors at 0,10,20,30,40s
		expect(decisions[0]).toBe("track");
		expect(decisions[1]).toBe("track");
		expect(decisions[2]).toBe("track");
		expect(decisions[3]).toBe("track");
		expect(decisions[4]).toBe("fire");
	});

	test("4 errors in 120s -> track only", () => {
		const { decisions } = fire(4, 0, 10_000);
		expect(decisions.every((d) => d === "track")).toBe(true);
	});

	test("5 errors spread over 600s -> never fires (window slides)", () => {
		const { decisions } = fire(5, 0, 150_000); // 0, 150, 300, 450, 600s — each rolls older entries out
		expect(decisions.every((d) => d === "track")).toBe(true);
	});

	test("disabled config returns 'disabled' without mutating state", () => {
		const state = makeEditLoopState();
		const decision = evaluateEditLoop(
			state,
			{ paneId: PANE, toolName: "edit", timestampMs: 0 },
			{ ...DEFAULT_EDIT_LOOP_CONFIG, enabled: false },
		);
		expect(decision).toBe("disabled");
		expect(state.timestamps.has(PANE)).toBe(false);
	});

	test("non-edit tool returns 'not-edit' without recording", () => {
		const state = makeEditLoopState();
		const decision = evaluateEditLoop(state, { paneId: PANE, toolName: "bash", timestampMs: 0 });
		expect(decision).toBe("not-edit");
		expect(state.timestamps.has(PANE)).toBe(false);
	});

	test("missing paneId returns 'skip'", () => {
		const state = makeEditLoopState();
		const decision = evaluateEditLoop(state, { paneId: "", toolName: "edit", timestampMs: 0 });
		expect(decision).toBe("skip");
	});

	test("once fired the same pane idempotently returns 'skip' until reset", () => {
		const { state } = fire(5, 0, 10_000);
		const after = evaluateEditLoop(state, { paneId: PANE, toolName: "edit", timestampMs: 50_000 });
		expect(after).toBe("skip");
		resetEditLoopPane(state, PANE);
		const reset = evaluateEditLoop(state, { paneId: PANE, toolName: "edit", timestampMs: 60_000 });
		expect(reset).toBe("track");
	});

	test("per-pane isolation: different pane keeps its own counter", () => {
		const state = makeEditLoopState();
		for (let i = 0; i < 4; i += 1) {
			evaluateEditLoop(state, { paneId: "%1", toolName: "edit", timestampMs: i * 1000 });
		}
		const second = evaluateEditLoop(state, { paneId: "%2", toolName: "edit", timestampMs: 5_000 });
		expect(second).toBe("track");
		expect(state.fired.has("%1")).toBe(false);
		expect(state.fired.has("%2")).toBe(false);
	});

	test("rolling window: gap of >window before 5th event resets the 1st", () => {
		const state = makeEditLoopState();
		// 4 events inside the window then a long gap, then another rapid burst.
		for (let i = 0; i < 4; i += 1) {
			expect(evaluateEditLoop(state, { paneId: PANE, toolName: "edit", timestampMs: i * 1000 })).toBe("track");
		}
		// Big gap: 200s later. The earliest entries fall out of the window.
		expect(evaluateEditLoop(state, { paneId: PANE, toolName: "edit", timestampMs: 200_000 })).toBe("track");
		// Three more events inside the window after the long gap.
		expect(evaluateEditLoop(state, { paneId: PANE, toolName: "edit", timestampMs: 201_000 })).toBe("track");
		expect(evaluateEditLoop(state, { paneId: PANE, toolName: "edit", timestampMs: 202_000 })).toBe("track");
		expect(evaluateEditLoop(state, { paneId: PANE, toolName: "edit", timestampMs: 203_000 })).toBe("track");
		// The next one rolls into a 5-deep window and fires.
		expect(evaluateEditLoop(state, { paneId: PANE, toolName: "edit", timestampMs: 204_000 })).toBe("fire");
	});

	test("trims to thresholdN entries so memory stays bounded", () => {
		const state = makeEditLoopState();
		for (let i = 0; i < 50; i += 1) {
			evaluateEditLoop(state, { paneId: PANE, toolName: "edit", timestampMs: i * 1000 });
		}
		const entries = state.timestamps.get(PANE)!;
		// Once fired, the pane is in `fired` so the entry list freezes —
		// but the most recent N entries must still be exactly thresholdN.
		expect(entries.length).toBeLessThanOrEqual(EDIT_LOOP_DEFAULT_THRESHOLD_N);
	});
});

describe("buildEditLoopSyntheticOutbox (vstack#67)", () => {
	test("status is blocked (not needs_completion); carries reason + window + count", () => {
		const outbox = buildEditLoopSyntheticOutbox({ agent: "rust", taskId: "task-1", consecutiveFailures: 5, windowMs: 120_000 });
		expect(outbox.status).toBe("blocked");
		expect(outbox.reason).toBe(EDIT_LOOP_REASON);
		expect(outbox.synthetic).toBe(true);
		expect(outbox.consecutive_failures).toBe(5);
		expect(outbox.window_sec).toBe(120);
		expect(outbox.summary).toMatch(/post-compaction edit-loop/);
		expect(outbox.summary).toMatch(/5 consecutive edit-tool failures/);
		expect(outbox.notes).toMatch(/master should kill the pane and re-dispatch/);
	});

	test("windowMs floors to seconds (>=1)", () => {
		expect(
			buildEditLoopSyntheticOutbox({ agent: "x", taskId: "y", consecutiveFailures: 5, windowMs: 500 })
				.window_sec,
		).toBe(1);
	});
});

describe("env parsers", () => {
	test("editLoopDetectorEnabledFromEnv defaults true, honors 0/false/off", () => {
		expect(editLoopDetectorEnabledFromEnv({} as NodeJS.ProcessEnv)).toBe(true);
		expect(editLoopDetectorEnabledFromEnv({ VSTACK_EDIT_LOOP_DETECTOR: "0" } as any)).toBe(false);
		expect(editLoopDetectorEnabledFromEnv({ VSTACK_EDIT_LOOP_DETECTOR: "false" } as any)).toBe(false);
		expect(editLoopDetectorEnabledFromEnv({ VSTACK_EDIT_LOOP_DETECTOR: "off" } as any)).toBe(false);
		expect(editLoopDetectorEnabledFromEnv({ VSTACK_EDIT_LOOP_DETECTOR: "1" } as any)).toBe(true);
	});

	test("editLoopThresholdFromEnv defaults to 5 and parses integers", () => {
		expect(editLoopThresholdFromEnv({} as NodeJS.ProcessEnv)).toBe(EDIT_LOOP_DEFAULT_THRESHOLD_N);
		expect(editLoopThresholdFromEnv({ VSTACK_EDIT_LOOP_THRESHOLD_N: "8" } as any)).toBe(8);
		expect(editLoopThresholdFromEnv({ VSTACK_EDIT_LOOP_THRESHOLD_N: "garbage" } as any)).toBe(EDIT_LOOP_DEFAULT_THRESHOLD_N);
		expect(editLoopThresholdFromEnv({ VSTACK_EDIT_LOOP_THRESHOLD_N: "0" } as any)).toBe(EDIT_LOOP_DEFAULT_THRESHOLD_N);
	});

	test("editLoopWindowMsFromEnv defaults to 120s in ms and parses overrides", () => {
		expect(editLoopWindowMsFromEnv({} as NodeJS.ProcessEnv)).toBe(EDIT_LOOP_DEFAULT_WINDOW_SEC * 1000);
		expect(editLoopWindowMsFromEnv({ VSTACK_EDIT_LOOP_WINDOW_SEC: "60" } as any)).toBe(60_000);
		expect(editLoopWindowMsFromEnv({ VSTACK_EDIT_LOOP_WINDOW_SEC: "garbage" } as any)).toBe(EDIT_LOOP_DEFAULT_WINDOW_SEC * 1000);
	});

	test("editLoopConfigFromEnv composes the three parsers", () => {
		const config = editLoopConfigFromEnv({
			VSTACK_EDIT_LOOP_DETECTOR: "1",
			VSTACK_EDIT_LOOP_THRESHOLD_N: "3",
			VSTACK_EDIT_LOOP_WINDOW_SEC: "30",
		} as any);
		expect(config).toEqual({ enabled: true, thresholdN: 3, windowMs: 30_000 });
	});
});
