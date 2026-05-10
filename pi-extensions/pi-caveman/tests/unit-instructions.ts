import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

import { instructions, shouldClarityEscape, type Mode } from "../extensions/prompt.ts";

const SNAP_DIR = join(dirname(fileURLToPath(import.meta.url)), "__snapshots__");
const UPDATE = process.env.UPDATE_SNAPSHOTS === "1";
const MODES = ["lite", "full", "ultra", "micro"] as const;
const BOUNDARY_KEYS = ["boundaryNormalForCode", "boundaryNormalForCommits", "boundaryNormalForReviews"] as const;

let originalPiDir;
let tmpRoot;
let userDir;
let projectDir;

function writeUserConfig(extensionConfig) {
	const settings = { vstack: { extensionManager: { config: { "@vanillagreen/pi-caveman": extensionConfig } } } };
	writeFileSync(join(userDir, "settings.json"), JSON.stringify(settings, null, 2));
}

function snapshotPath(name) { return join(SNAP_DIR, `${name}.txt`); }

function compareSnapshot(name, actual) {
	const path = snapshotPath(name);
	if (UPDATE || !existsSync(path)) {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, actual);
		return;
	}
	const expected = readFileSync(path, "utf8");
	assert.equal(actual, expected, `snapshot mismatch for ${name}\n--- actual ---\n${actual}\n--- expected ---\n${expected}`);
}

before(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "pi-caveman-test-"));
	userDir = join(tmpRoot, "agent");
	projectDir = join(tmpRoot, "project");
	mkdirSync(userDir, { recursive: true });
	mkdirSync(join(projectDir, ".pi"), { recursive: true });
	originalPiDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = userDir;
});

after(() => {
	if (originalPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalPiDir;
	if (tmpRoot && existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
});

describe("instructions() snapshot matrix", () => {
	for (const mode of MODES) {
		for (const clarity of [false, true]) {
			for (const boundariesOn of [true, false]) {
				const name = `${mode}-${clarity ? "clarity" : "clean"}-boundaries-${boundariesOn ? "on" : "off"}`;
				it(`renders ${name}`, () => {
					const config = { mode };
					for (const key of BOUNDARY_KEYS) config[key] = boundariesOn;
					writeUserConfig(config);
					const rendered = instructions(mode, projectDir, clarity);
					compareSnapshot(name, rendered);
				});
			}
		}
	}

	it("returns empty string when mode is off", () => {
		writeUserConfig({ mode: "off" });
		assert.equal(instructions("off", projectDir, false), "");
		assert.equal(instructions("off", projectDir, true), "");
	});

	it("clarity-escape branch ends with literal 'Caveman resume.' sentinel", () => {
		writeUserConfig({ mode: "full" });
		for (const mode of MODES) {
			const rendered = instructions(mode, projectDir, true);
			assert.match(rendered, /Caveman resume\./, `${mode} clarity escape missing sentinel`);
		}
	});

	it("respects customPromptSuffix when set", () => {
		writeUserConfig({ mode: "full", customPromptSuffix: "PROJECT-SUFFIX-SENTINEL" });
		const rendered = instructions("full", projectDir, false);
		assert.match(rendered, /PROJECT-SUFFIX-SENTINEL/);
	});

	it("every active mode renders imperative directives", () => {
		writeUserConfig({ mode: "full", boundaryNormalForCode: true, boundaryNormalForCommits: true, boundaryNormalForReviews: true });
		for (const mode of MODES) {
			const clean = instructions(mode, projectDir, false);
			assert.match(clean, /\bMUST\b/, `${mode} clean missing MUST directive`);
			// micro is the minimum-prompt mode; its clean branch deliberately
			// omits Do NOT to preserve its token-budget framing. Every other
			// mode and every clarity branch must contain Do NOT.
			if (mode !== "micro") {
				assert.match(clean, /\bDo NOT\b/, `${mode} clean missing Do NOT directive`);
			}
			const clarity = instructions(mode, projectDir, true);
			assert.match(clarity, /\bMUST\b/, `${mode} clarity missing MUST directive`);
			assert.match(clarity, /\bDo NOT\b/, `${mode} clarity missing Do NOT directive`);
		}
	});

	it("every rendered prompt opens with the canonical 'You MUST respond in caveman' anchor", () => {
		writeUserConfig({ mode: "full" });
		for (const mode of MODES) {
			for (const clarity of [false, true]) {
				const rendered = instructions(mode, projectDir, clarity);
				assert.match(rendered, /^You MUST respond in caveman /, `${mode}${clarity ? " clarity" : ""} opener mismatch`);
			}
		}
	});
});

describe("shouldClarityEscape() — current behavior baseline", () => {
	const shouldMatch = [
		"please review for security vulnerabilities",
		"this would force-push and rewrite history",
		"DROP TABLE users",
		"rm -rf the build dir",
		"git reset --hard origin/main",
		"is this a credential exposure?",
		"that's a destructive operation",
		"can you clarify the trade-off",
		"I'm confused about the data flow",
		"the spec is ambiguous",
	];
	const shouldNotMatch = [
		"refactor the parser to use the new API",
		"add a unit test for the queue",
		"format the table output",
		"please confirm the version bumped",
		"delete the old log entries",
	];
	for (const phrase of shouldMatch) {
		it(`MATCHES: ${phrase}`, () => {
			assert.equal(shouldClarityEscape(phrase), true);
		});
	}
	for (const phrase of shouldNotMatch) {
		it(`SKIPS: ${phrase}`, () => {
			assert.equal(shouldClarityEscape(phrase), false);
		});
	}
});
