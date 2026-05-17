// Regression coverage for vstack#68: bell wakes need to be filtered.
// Plain BEL characters from rendering/idle terminals are noise; even
// canonical-tag bell wakes can storm during normal agent iteration.
// The wake-filter applies two gates: non-canonical drop + per-pane rate
// limit (FD_BELL_WAKE_INTERVAL_SEC, default 60s).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
	BELL_NON_CANONICAL_DROP_REASON,
	BELL_RATE_LIMIT_DROP_REASON,
	BELL_WAKE_INTERVAL_DEFAULT_SEC,
	bellWakeIntervalFromEnv,
	makeBellWakeState,
	recordBellWake,
	shouldEmitBellWake,
} from "../../src/daemon/wake-filter.ts";

describe("shouldEmitBellWake (vstack#68)", () => {
	test("non-canonical tag (rendering) -> drop with non-canonical reason", () => {
		const state = makeBellWakeState();
		const decision = shouldEmitBellWake(state, {
			paneId: "%1",
			tag: "rendering",
			isCanonical: false,
			intervalSec: 60,
			nowSec: 0,
		});
		expect(decision.emit).toBe(false);
		if (!decision.emit) expect(decision.reason).toBe(BELL_NON_CANONICAL_DROP_REASON);
	});

	test("non-canonical tag (idle) -> drop", () => {
		const state = makeBellWakeState();
		const decision = shouldEmitBellWake(state, {
			paneId: "%1",
			tag: "idle",
			isCanonical: false,
			intervalSec: 60,
			nowSec: 0,
		});
		expect(decision.emit).toBe(false);
	});

	test("canonical tag (first observation) -> emit", () => {
		const state = makeBellWakeState();
		const decision = shouldEmitBellWake(state, {
			paneId: "%1",
			tag: "merge-now",
			isCanonical: true,
			intervalSec: 60,
			nowSec: 0,
		});
		expect(decision.emit).toBe(true);
	});

	test("three bells at 0s, 5s, 70s with interval=60: emit, suppress, emit", () => {
		const state = makeBellWakeState();
		const t1 = shouldEmitBellWake(state, { paneId: "%1", tag: "merge-now", isCanonical: true, intervalSec: 60, nowSec: 0 });
		expect(t1.emit).toBe(true);
		recordBellWake(state, "%1", "merge-now", 0);

		const t2 = shouldEmitBellWake(state, { paneId: "%1", tag: "merge-now", isCanonical: true, intervalSec: 60, nowSec: 5 });
		expect(t2.emit).toBe(false);
		if (!t2.emit) {
			expect(t2.reason).toBe(BELL_RATE_LIMIT_DROP_REASON);
			expect(t2.suppressedUntil).toBe(60);
		}

		const t3 = shouldEmitBellWake(state, { paneId: "%1", tag: "merge-now", isCanonical: true, intervalSec: 60, nowSec: 70 });
		expect(t3.emit).toBe(true);
	});

	test("rate limit is per-pane (a different pane's bell at 5s still fires)", () => {
		const state = makeBellWakeState();
		recordBellWake(state, "%1", "merge-now", 0);
		const otherPane = shouldEmitBellWake(state, { paneId: "%2", tag: "merge-now", isCanonical: true, intervalSec: 60, nowSec: 5 });
		expect(otherPane.emit).toBe(true);
	});

	test("rate limit is per-tag (two distinct canonical tags on the same pane both fire inside the window)", () => {
		const state = makeBellWakeState();
		const mergeNow = shouldEmitBellWake(state, { paneId: "%1", tag: "merge-now", isCanonical: true, intervalSec: 60, nowSec: 0 });
		expect(mergeNow.emit).toBe(true);
		recordBellWake(state, "%1", "merge-now", 0);

		const questionOpened = shouldEmitBellWake(state, { paneId: "%1", tag: "question.opened", isCanonical: true, intervalSec: 60, nowSec: 5 });
		expect(questionOpened.emit).toBe(true);
		recordBellWake(state, "%1", "question.opened", 5);

		const mergeAgain = shouldEmitBellWake(state, { paneId: "%1", tag: "merge-now", isCanonical: true, intervalSec: 60, nowSec: 10 });
		expect(mergeAgain.emit).toBe(false);
		if (!mergeAgain.emit) expect(mergeAgain.reason).toBe(BELL_RATE_LIMIT_DROP_REASON);

		const questionAgain = shouldEmitBellWake(state, { paneId: "%1", tag: "question.opened", isCanonical: true, intervalSec: 60, nowSec: 10 });
		expect(questionAgain.emit).toBe(false);
	});

	test("interval=0 disables rate limiting", () => {
		const state = makeBellWakeState();
		recordBellWake(state, "%1", "merge-now", 0);
		const decision = shouldEmitBellWake(state, { paneId: "%1", tag: "merge-now", isCanonical: true, intervalSec: 0, nowSec: 1 });
		expect(decision.emit).toBe(true);
	});

	test("default interval is 60 seconds", () => {
		expect(BELL_WAKE_INTERVAL_DEFAULT_SEC).toBe(60);
	});
});

describe("bellWakeIntervalFromEnv", () => {
	test("unset env -> default 60s", () => {
		expect(bellWakeIntervalFromEnv({} as NodeJS.ProcessEnv)).toBe(60);
	});

	test("valid positive integer override", () => {
		expect(bellWakeIntervalFromEnv({ FD_BELL_WAKE_INTERVAL_SEC: "90" } as any)).toBe(90);
		expect(bellWakeIntervalFromEnv({ FD_BELL_WAKE_INTERVAL_SEC: "0" } as any)).toBe(0);
	});

	test("garbage falls back to default", () => {
		expect(bellWakeIntervalFromEnv({ FD_BELL_WAKE_INTERVAL_SEC: "" } as any)).toBe(60);
		expect(bellWakeIntervalFromEnv({ FD_BELL_WAKE_INTERVAL_SEC: "abc" } as any)).toBe(60);
		expect(bellWakeIntervalFromEnv({ FD_BELL_WAKE_INTERVAL_SEC: "-5" } as any)).toBe(60);
	});
});

describe("loop.ts bell branch wires the filter (vstack#68)", () => {
	const loopSrc = readFileSync(new URL("../../src/daemon/loop.ts", import.meta.url), "utf8");

	test("imports the bell wake filter helpers", () => {
		expect(loopSrc).toContain("shouldEmitBellWake");
		expect(loopSrc).toContain("recordBellWake");
		expect(loopSrc).toContain("bellWakeIntervalFromEnv");
	});

	test("bell branch consults shouldEmitBellWake before appending event", () => {
		// The wake-filter call must appear before the bell appendEvent.
		const filterIdx = loopSrc.indexOf("shouldEmitBellWake(bellWakeState");
		const bellAppendIdx = loopSrc.indexOf("reason: \"bell\"");
		expect(filterIdx).toBeGreaterThan(-1);
		expect(bellAppendIdx).toBeGreaterThan(-1);
		expect(filterIdx).toBeLessThan(bellAppendIdx);
	});

	test("bell-drop is logged on suppression with the reason", () => {
		expect(loopSrc).toContain("bell-drop");
	});
});
