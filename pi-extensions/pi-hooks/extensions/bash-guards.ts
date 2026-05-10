import { spawnSync } from "node:child_process";

import { findCargoWorkspaceRoot, runCargo, runWorkspaceClippy } from "./cargo.js";

/**
 * Match a bash command that is exactly `cd <target>` with no shell operators
 * that would scope the directory change (no `&&`, `||`, `|`, `;`, parens,
 * backticks, `$(...)`, or embedded newlines). Such commands change Pi's CWD
 * across subsequent tool calls and leak state between unrelated tools.
 *
 * Mirrors `hooks/block-bare-cd.sh`.
 */
const BARE_CD = /^cd\s+[^&|;()`$\n]+$/;

export function isBareCd(command: string): boolean {
	return BARE_CD.test(command.trim());
}

/**
 * Match `git commit` as a verb, allowing alias-style invocations like
 * `git -C path commit` and `git commit -m "..."`. Does not match
 * `git commit-tree` or `gitfoo commit`.
 */
const GIT_COMMIT = /(^|\s)git(\s+[^\s]+)*\s+commit(\s|$)/;

export function isGitCommit(command: string): boolean {
	return GIT_COMMIT.test(command);
}

function gitListRustFiles(cwd: string, args: string[]): string[] {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 5000 });
	if (result.status !== 0 || typeof result.stdout !== "string") return [];
	return result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.endsWith(".rs"));
}

/**
 * Rust files in the working tree that a `git commit` would care about.
 *
 * The hook fires BEFORE the bash command executes, so when the agent issues
 * `git add x.rs && git commit -m '…'` in a single chained command, `git diff
 * --cached --name-only` still reports an empty staged set at this point. To
 * avoid silently letting that through, also count unstaged-but-modified `.rs`
 * files. If either set is non-empty, the commit is treated as relevant.
 *
 * Returns the union, deduped.
 */
function rustFilesRelevantToCommit(cwd: string): string[] {
	const staged = gitListRustFiles(cwd, ["diff", "--cached", "--name-only"]);
	const unstaged = gitListRustFiles(cwd, ["diff", "--name-only"]);
	return [...new Set([...staged, ...unstaged])];
}

export interface BlockReason {
	reason: string;
}

/**
 * Pre-commit gate. Runs `cargo fmt --check` then `cargo clippy --workspace
 * --all-targets -- -D warnings`. Returns a block reason on failure, or
 * `undefined` to let the commit proceed. No-ops when there are no staged
 * `.rs` files (so non-Rust commits aren't slowed down).
 *
 * Budget split: metadata gets a small share, then fmt and clippy each get the
 * remainder so the total wall-clock stays inside `timeoutMs`.
 */
export function runPreCommitCheck(cwd: string, timeoutMs: number): BlockReason | undefined {
	const metadataBudget = Math.min(5000, Math.floor(timeoutMs / 4));
	const root = findCargoWorkspaceRoot(cwd, metadataBudget);
	if (!root) return undefined;

	const rustFiles = rustFilesRelevantToCommit(cwd);
	if (rustFiles.length === 0) return undefined;

	const remaining = Math.max(1, timeoutMs - metadataBudget);
	const fmtBudget = Math.max(1, Math.floor(remaining / 3));
	const clippyBudget = Math.max(1, remaining - fmtBudget);

	const fmt = runCargo(["fmt", "--check"], root, fmtBudget);
	if (fmt.timedOut) {
		return { reason: `pi-hooks pre-commit: cargo fmt --check timed out after ${fmtBudget}ms.` };
	}
	if (fmt.exitCode !== 0) {
		return { reason: "pi-hooks pre-commit: cargo fmt --check failed. Run `cargo fmt` first." };
	}

	const clippy = runWorkspaceClippy(root, clippyBudget);
	if (clippy.timedOut) {
		return { reason: `pi-hooks pre-commit: cargo clippy timed out after ${clippyBudget}ms.` };
	}
	if (clippy.exitCode !== 0) {
		return { reason: "pi-hooks pre-commit: cargo clippy found warnings. Fix them before committing." };
	}
	return undefined;
}
