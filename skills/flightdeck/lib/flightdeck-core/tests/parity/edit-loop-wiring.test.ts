// vstack#67 wiring test: the bash pi subscriber consumes
// tool_execution_end events with toolName=='edit' and emits a wake-
// event row with classifier_tag=pi-edit-tool-loop once N consecutive
// errors fall inside the M-second window. The bash mirror must stay in
// lock step with the canonical TS evaluateEditLoop() in
// src/daemon/edit-loop-detector.ts (CLAUDE.md parity rule).

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	EDIT_LOOP_CLASSIFIER_TAG,
	EDIT_LOOP_DEFAULT_THRESHOLD_N,
	EDIT_LOOP_DEFAULT_WINDOW_SEC,
	evaluateEditLoop,
	makeEditLoopState,
} from "../../src/daemon/edit-loop-detector.ts";
import { isCanonicalTag } from "../../src/daemon/events.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SUBSCRIBERS_BASH = resolve(HERE, "../../../../scripts/lib/subscribers.bash");

const bashSrc = readFileSync(SUBSCRIBERS_BASH, "utf8");

describe("edit-loop wiring: bash subscriber mirror (vstack#67)", () => {
	test("EDIT_LOOP_CLASSIFIER_TAG is canonical so the daemon routes the wake", () => {
		expect(EDIT_LOOP_CLASSIFIER_TAG).toBe("pi-edit-tool-loop");
		expect(isCanonicalTag(EDIT_LOOP_CLASSIFIER_TAG)).toBe(true);
	});

	test("bash pi_subscriber_loop honors VSTACK_EDIT_LOOP_DETECTOR=0 disable", () => {
		expect(bashSrc).toMatch(/VSTACK_EDIT_LOOP_DETECTOR/);
		expect(bashSrc).toMatch(/case "\$edit_loop_enabled" in 0\|false\|FALSE\|off\|OFF/);
	});

	test("bash defaults match TS detector defaults (N=5, window=120s)", () => {
		expect(bashSrc).toMatch(new RegExp(`VSTACK_EDIT_LOOP_THRESHOLD_N:-${EDIT_LOOP_DEFAULT_THRESHOLD_N}`));
		expect(bashSrc).toMatch(new RegExp(`VSTACK_EDIT_LOOP_WINDOW_SEC:-${EDIT_LOOP_DEFAULT_WINDOW_SEC}`));
	});

	test("bash event filter matches tool_execution_end + toolName=edit + isError", () => {
		// Round-2 fix: match upstream ToolExecutionEndEvent shape
		// (.data.isError) instead of the prior guesses.
		expect(bashSrc).toMatch(/event == "tool_execution_end"/);
		expect(bashSrc).toMatch(/== "edit"/);
		expect(bashSrc).toMatch(/\.data\.isError == true/);
		expect(bashSrc).toMatch(/\.data\.toolName/);
	});

	test("bash emits classifier_tag=pi-edit-tool-loop with consecutive_failures + window_sec details", () => {
		expect(bashSrc).toContain('--arg tag "pi-edit-tool-loop"');
		expect(bashSrc).toMatch(/consecutive_failures:\$failures/);
		expect(bashSrc).toMatch(/window_sec:\$window/);
		expect(bashSrc).toMatch(/event_type:"tool_execution_error"/);
	});

	test("bash mirror references the canonical TS module name", () => {
		expect(bashSrc).toContain("edit-loop-detector.ts");
		expect(bashSrc).toMatch(/evaluateEditLoop/);
	});

	test("bash mirror dedupes via edit_loop_fired so the wake fires once per pane", () => {
		expect(bashSrc).toContain("edit_loop_fired=0");
		expect(bashSrc).toContain(`"$edit_loop_fired" == "0"`);
		expect(bashSrc).toContain("edit_loop_fired=1");
	});
});

describe("edit-loop wiring: 5-in-window scenario (vstack#67)", () => {
	test("simulating 5 tool_execution_error events inside 120s fires on the 5th", () => {
		const state = makeEditLoopState();
		const decisions: string[] = [];
		for (let i = 0; i < 5; i += 1) {
			decisions.push(
				evaluateEditLoop(state, {
					paneId: "%42",
					toolName: "edit",
					timestampMs: i * 10_000, // 0, 10, 20, 30, 40s — all inside 120s
				}),
			);
		}
		expect(decisions).toEqual(["track", "track", "track", "track", "fire"]);
		expect(state.fired.has("%42")).toBe(true);
	});

	test("4-in-window then 1 outside window -> no fire", () => {
		const state = makeEditLoopState();
		const decisions: string[] = [];
		// 4 inside, 1 outside (200s later, past 120s window).
		for (let i = 0; i < 4; i += 1) {
			decisions.push(evaluateEditLoop(state, { paneId: "%9", toolName: "edit", timestampMs: i * 10_000 }));
		}
		decisions.push(evaluateEditLoop(state, { paneId: "%9", toolName: "edit", timestampMs: 200_000 }));
		expect(decisions.every((d) => d === "track")).toBe(true);
	});
});

// Round-2 fix (reviewer-error blocker): the prior jq filter guessed at
// .data.error / .data.result.error / .data.success but pi-coding-agent's
// real ToolExecutionEndEvent (dist/core/extensions/types.d.ts) exposes
// the error flag at .data.isError. The next two tests pipe a synthetic
// upstream payload through the exact same jq selector the subscriber
// uses so the filter never drifts from the real event shape.
const SELECT_FILTER = `
select(
  (.type == "event" and .event == "tool_execution_end" and ((.data.toolName // "") == "edit") and (.data.isError == true))
)
`;

function jqMatches(filter: string, payload: unknown): boolean {
	const r = spawnSync("jq", ["-c", filter], { encoding: "utf8", input: JSON.stringify(payload) });
	if (r.status !== 0) return false;
	return (r.stdout ?? "").trim().length > 0;
}

describe("edit-loop wiring: jq filter parity against real upstream event shape (vstack#67 blocker)", () => {
	const editError = {
		type: "event",
		event: "tool_execution_end",
		data: {
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "edit",
			isError: true,
			result: { content: [{ type: "text", text: 'Validation failed for tool "edit":' }] },
		},
	};

	test("matches real ToolExecutionEndEvent with isError:true and toolName:edit", () => {
		expect(jqMatches(SELECT_FILTER, editError)).toBe(true);
	});

	test("does NOT match when isError is false (successful edit)", () => {
		const ok = { ...editError, data: { ...editError.data, isError: false, result: { ok: true } } };
		expect(jqMatches(SELECT_FILTER, ok)).toBe(false);
	});

	test("does NOT match a different tool with isError:true (only edit triggers loop)", () => {
		const other = { ...editError, data: { ...editError.data, toolName: "bash" } };
		expect(jqMatches(SELECT_FILTER, other)).toBe(false);
	});

	test("does NOT match when isError is missing entirely (legacy event)", () => {
		const legacy = { type: "event", event: "tool_execution_end", data: { toolName: "edit" } };
		expect(jqMatches(SELECT_FILTER, legacy)).toBe(false);
	});

	test("bash subscriber jq selector uses the same .data.isError shape", () => {
		expect(bashSrc).toMatch(/\.data\.isError == true/);
		expect(bashSrc).toMatch(/\.data\.toolName/);
		// And no longer carries the wrong-field guesses.
		expect(bashSrc).not.toMatch(/\.data\.error \/\/ \.data\.result\.error \/\/ \.data\.success/);
	});
});
