import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = new URL("../scripts/deep-research", import.meta.url).pathname;

test("doctor reports runtime status", () => {
  const result = spawnSync(process.execPath, [script, "doctor"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  const json = JSON.parse(result.stdout);
  assert.equal(json.ok, true);
  assert.equal(json.fetch, true);
});

test("help documents modes, context args, and sidecar behavior", () => {
  const result = spawnSync(process.execPath, [script, "help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  const json = JSON.parse(result.stdout);
  assert.equal(json.ok, true);
  assert.match(json.usage, /report\|json\|doctor/);
  assert.equal(json.modes.full.numResults, 150);
  assert.ok(json.flags.includes("--query-file <path>"));
  assert.ok(json.flags.includes("--context-glob <glob>"));
  assert.match(json.sidecar, /not embedded in findings\.md/);
});

test("findings template and format guide forbid embedded raw metadata", () => {
  const template = readFileSync(new URL("../templates/findings.md", import.meta.url), "utf8");
  const guide = readFileSync(new URL("../templates/findings-report-format.md", import.meta.url), "utf8");
  assert.match(template, /## Research Metadata/);
  assert.match(template, /Recommendation \/ Decision Criteria/);
  assert.doesNotMatch(template, /## Raw Exa Metadata|\{\{raw_json\}\}|```json/);
  assert.match(guide, /not a machine-readable JSON schema/);
  assert.match(guide, /Do not embed raw Exa JSON/);
});

test("missing key fails with setup instructions", () => {
  const env = { ...process.env };
  delete env.EXA_API_KEY;
  delete env.EXA_MOCK_RESPONSE_FILE;
  const cwd = mkdtempSync(join(tmpdir(), "deep-research-no-env-"));
  const result = spawnSync(process.execPath, [script, "report", "question"], { encoding: "utf8", env, cwd });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /EXA_API_KEY/);
});

test("mocked report writes findings and raw output", () => {
  const dir = mkdtempSync(join(tmpdir(), "deep-research-"));
  const mock = join(dir, "mock.json");
  const output = join(dir, "findings.md");
  const raw = join(dir, "raw.json");
  writeFileSync(mock, JSON.stringify({ answer: "Answer", results: [{ title: "Source", url: "https://example.com" }] }));
  const result = spawnSync(process.execPath, [script, "report", "question", "--output", output, "--raw-output", raw], { encoding: "utf8", env: { ...process.env, EXA_MOCK_RESPONSE_FILE: mock } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(output, "utf8"), /## Evidence and Sources/);
  assert.match(readFileSync(output, "utf8"), /https:\/\/example\.com/);
  assert.doesNotMatch(readFileSync(output, "utf8"), /Raw Exa Metadata|```json/);
  assert.match(readFileSync(raw, "utf8"), /Answer/);
});

test("mocked report defaults raw metadata to adjacent sidecar", () => {
  const dir = mkdtempSync(join(tmpdir(), "deep-research-sidecar-"));
  const mock = join(dir, "mock.json");
  const output = join(dir, "findings.md");
  const raw = join(dir, "findings.raw.json");
  writeFileSync(mock, JSON.stringify({ answer: "Answer", results: [{ title: "Source", url: "https://example.com" }] }));
  const result = spawnSync(process.execPath, [script, "report", "question", "--output", output], { encoding: "utf8", env: { ...process.env, EXA_MOCK_RESPONSE_FILE: mock } });
  assert.equal(result.status, 0, result.stderr);
  const stdout = JSON.parse(result.stdout);
  assert.equal(stdout.rawOutput, raw);
  assert.equal(stdout.mode, "standard");
  assert.equal(existsSync(raw), true);
  assert.match(readFileSync(output, "utf8"), /Raw metadata sidecar:/);
  assert.match(readFileSync(raw, "utf8"), /"researchMode": "standard"/);
});

test("mode mapping and explicit overrides are recorded in sidecar metadata", () => {
  const dir = mkdtempSync(join(tmpdir(), "deep-research-mode-"));
  const mock = join(dir, "mock.json");
  const output = join(dir, "findings.md");
  const raw = join(dir, "raw.json");
  writeFileSync(mock, JSON.stringify({ answer: "Answer", results: [] }));
  const result = spawnSync(process.execPath, [script, "report", "question", "--mode", "lite", "--type", "deep", "--num-results", "7", "--text-max-characters", "88", "--output", output, "--raw-output", raw], { encoding: "utf8", env: { ...process.env, EXA_MOCK_RESPONSE_FILE: mock } });
  assert.equal(result.status, 0, result.stderr);
  const sidecar = JSON.parse(readFileSync(raw, "utf8"));
  assert.equal(sidecar.metadata.researchMode, "lite");
  assert.equal(sidecar.metadata.type, "deep");
  assert.equal(sidecar.metadata.numResults, 7);
  assert.equal(sidecar.metadata.textMaxCharacters, 88);
});

test("query-file @path and context-glob are accepted", () => {
  const dir = mkdtempSync(join(tmpdir(), "deep-research-context-"));
  const mock = join(dir, "mock.json");
  const output = join(dir, "findings.md");
  writeFileSync(mock, JSON.stringify({ answer: "Answer", results: [{ title: "Source", url: "https://example.com" }] }));
  writeFileSync(join(dir, "prompt.txt"), "Question from prompt file");
  writeFileSync(join(dir, "context-b.md"), "B context");
  writeFileSync(join(dir, "context-a.md"), "A context");
  const result = spawnSync(process.execPath, [script, "report", "--query-file", "@prompt.txt", "--context-glob", "context-*.md", "--output", output], { encoding: "utf8", cwd: dir, env: { ...process.env, EXA_MOCK_RESPONSE_FILE: mock } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(output, "utf8"), /Question from prompt file/);
});

test("invalid mode fails clearly", () => {
  const dir = mkdtempSync(join(tmpdir(), "deep-research-bad-mode-"));
  const mock = join(dir, "mock.json");
  writeFileSync(mock, JSON.stringify({ answer: "Answer", results: [] }));
  const result = spawnSync(process.execPath, [script, "report", "question", "--mode", "slow"], { encoding: "utf8", env: { ...process.env, EXA_MOCK_RESPONSE_FILE: mock } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid --mode slow/);
});

test("full mode aggregates multiple mock responses and dedupes URLs", () => {
  const dir = mkdtempSync(join(tmpdir(), "deep-research-full-"));
  const mock = join(dir, "mock.json");
  const output = join(dir, "findings.md");
  const raw = join(dir, "raw.json");
  writeFileSync(mock, JSON.stringify([
    { answer: "First", results: [{ title: "A", url: "https://example.com/a" }, { title: "Dup", url: "https://example.com/dup" }] },
    { answer: "Second", results: [{ title: "Dup 2", url: "https://example.com/dup" }, { title: "B", url: "https://example.com/b" }] },
  ]));
  const result = spawnSync(process.execPath, [script, "report", "main", "--mode", "full", "--additional-query", "second", "--output", output, "--raw-output", raw], { encoding: "utf8", env: { ...process.env, EXA_MOCK_RESPONSE_FILE: mock } });
  assert.equal(result.status, 0, result.stderr);
  const stdout = JSON.parse(result.stdout);
  assert.equal(stdout.queryCount, 2);
  assert.equal(stdout.uniqueSources, 3);
  const sidecar = JSON.parse(readFileSync(raw, "utf8"));
  assert.equal(sidecar.metadata.sourceCount, 4);
  assert.equal(sidecar.metadata.uniqueSourceCount, 3);
  const report = readFileSync(output, "utf8");
  assert.match(report, /Mode: full/);
  assert.doesNotMatch(report, /Dup 2/);
});

test("resolves EXA_API_KEY op:// references with op CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), "deep-research-op-"));
  const bin = join(dir, "bin");
  const mock = join(dir, "mock.json");
  const output = join(dir, "findings.md");
  mkdirSync(bin, { recursive: true });
  writeFileSync(mock, JSON.stringify({ answer: "Answer", results: [{ title: "Source", url: "https://example.com" }] }));
  writeFileSync(join(bin, "op"), "#!/usr/bin/env bash\n[ \"$1\" = read ] && [ \"$2\" = 'op://vault/exa/key' ] && { printf resolved-exa; exit 0; }\nexit 1\n");
  chmodSync(join(bin, "op"), 0o755);
  const result = spawnSync(process.execPath, [script, "report", "question", "--output", output], {
    encoding: "utf8",
    env: { ...process.env, EXA_API_KEY: "op://vault/exa/key", EXA_MOCK_RESPONSE_FILE: mock, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(output, "utf8"), /Answer/);
});
