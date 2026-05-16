// vstack#60 workaround regression test: when pi-agents-tmux spawns a
// subagent Pi pane, the generated launcher script must export
// PI_BRIDGE_PARENT_SESSION_ID + PI_BRIDGE_CHILD_ROLE so the
// pi-session-bridge in the child synthesizes a unique session id.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANE_SRC = resolve(HERE, "../extensions/subagent/pane.ts");

test("writeLauncher template exports PI_BRIDGE_PARENT_SESSION_ID for subagent pane", () => {
	const src = readFileSync(PANE_SRC, "utf8");
	assert.match(src, /export PI_BRIDGE_PARENT_SESSION_ID=\$\{shellQuote\(parentSessionId\)\}/);
});

test("writeLauncher template exports PI_BRIDGE_CHILD_ROLE=subagent", () => {
	const src = readFileSync(PANE_SRC, "utf8");
	assert.match(src, /export PI_BRIDGE_CHILD_ROLE=subagent/);
});

test("PI_BRIDGE_* env vars are exported BEFORE the exec line so the child Pi inherits them", () => {
	const src = readFileSync(PANE_SRC, "utf8");
	const exportIdx = src.indexOf("export PI_BRIDGE_PARENT_SESSION_ID");
	const execIdx = src.indexOf("exec ${command}");
	assert.ok(exportIdx > -1, "expected PI_BRIDGE_PARENT_SESSION_ID export in writeLauncher");
	assert.ok(execIdx > -1, "expected exec line in writeLauncher");
	assert.ok(exportIdx < execIdx, "PI_BRIDGE_* exports must come before exec");
});

test("PI_BRIDGE_PARENT_SESSION_ID mirrors the existing PI_SUBAGENT_PARENT_SESSION_ID value", () => {
	// Both vars receive shellQuote(parentSessionId) from the same source
	// so the parent's identity is consistently propagated.
	const src = readFileSync(PANE_SRC, "utf8");
	const piSubagent = src.match(/PI_SUBAGENT_PARENT_SESSION_ID=\$\{shellQuote\(([^)]+)\)\}/);
	const piBridge = src.match(/PI_BRIDGE_PARENT_SESSION_ID=\$\{shellQuote\(([^)]+)\)\}/);
	assert.ok(piSubagent, "expected PI_SUBAGENT_PARENT_SESSION_ID export");
	assert.ok(piBridge, "expected PI_BRIDGE_PARENT_SESSION_ID export");
	assert.equal(piBridge![1], piSubagent![1], "both env vars must propagate the same parent id expression");
});
