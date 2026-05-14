#!/usr/bin/env bash
# Regression tests for worktree remove diagnostics and branch cleanup.
set -euo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKTREE_SCRIPT="$(cd "$TEST_DIR/.." && pwd)/scripts/worktree"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

PASS=0
FAIL=0

assert_eq() {
  local got="$1" want="$2" name="$3"
  if [[ "$got" == "$want" ]]; then
    PASS=$((PASS + 1))
    printf '  ok    %s\n' "$name"
  else
    FAIL=$((FAIL + 1))
    printf '  FAIL  %s\n        expected: %s\n        got:      %s\n' "$name" "$want" "$got"
  fi
}

assert_contains() {
  local haystack="$1" needle="$2" name="$3"
  if grep -qF -- "$needle" <<<"$haystack"; then
    PASS=$((PASS + 1))
    printf '  ok    %s\n' "$name"
  else
    FAIL=$((FAIL + 1))
    printf '  FAIL  %s\n        wanted substring: %s\n        in: %s\n' "$name" "$needle" "$haystack"
  fi
}

assert_path_absent() {
  local path="$1" name="$2"
  if [[ ! -e "$path" ]]; then
    PASS=$((PASS + 1))
    printf '  ok    %s\n' "$name"
  else
    FAIL=$((FAIL + 1))
    printf '  FAIL  %s\n        still exists: %s\n' "$name" "$path"
  fi
}

assert_git_worktree() {
  local path="$1" name="$2"
  if git -C "$path" rev-parse --git-dir >/dev/null 2>&1; then
    PASS=$((PASS + 1))
    printf '  ok    %s\n' "$name"
  else
    FAIL=$((FAIL + 1))
    printf '  FAIL  %s\n        not a git worktree: %s\n' "$name" "$path"
  fi
}

assert_symlink_target() {
  local path="$1" want="$2" name="$3"
  if [[ -L "$path" && "$(readlink "$path")" == "$want" ]]; then
    PASS=$((PASS + 1))
    printf '  ok    %s\n' "$name"
  else
    FAIL=$((FAIL + 1))
    local got="<missing>"
    [[ -e "$path" || -L "$path" ]] && got="$(readlink "$path" 2>/dev/null || printf '<not symlink>')"
    printf '  FAIL  %s\n        expected symlink target: %s\n        got:                     %s\n' "$name" "$want" "$got"
  fi
}

assert_git_status_clean_for_path() {
  local repo="$1" path="$2" name="$3"
  local status
  status=$(git -C "$repo" status --short -- "$path")
  if [[ -z "$status" ]]; then
    PASS=$((PASS + 1))
    printf '  ok    %s\n' "$name"
  else
    FAIL=$((FAIL + 1))
    printf '  FAIL  %s\n        git status: %s\n' "$name" "$status"
  fi
}

assert_branch_exists() {
  local repo="$1" branch="$2" name="$3"
  if git -C "$repo" show-ref --verify --quiet "refs/heads/$branch"; then
    PASS=$((PASS + 1))
    printf '  ok    %s\n' "$name"
  else
    FAIL=$((FAIL + 1))
    printf '  FAIL  %s\n        missing branch: %s\n' "$name" "$branch"
  fi
}

assert_branch_absent() {
  local repo="$1" branch="$2" name="$3"
  if git -C "$repo" show-ref --verify --quiet "refs/heads/$branch"; then
    FAIL=$((FAIL + 1))
    printf '  FAIL  %s\n        branch still exists: %s\n' "$name" "$branch"
  else
    PASS=$((PASS + 1))
    printf '  ok    %s\n' "$name"
  fi
}

make_repo() {
  local repo="$1"
  mkdir -p "$repo"
  git -C "$repo" init -q -b main
  git -C "$repo" config user.email test@example.com
  git -C "$repo" config user.name Test
  printf 'base\n' > "$repo/file.txt"
  git -C "$repo" add file.txt
  git -C "$repo" commit -q -m base
}

echo "=== worktree remove ==="

# Merged/no-extra-commit branch: worktree and branch both disappear, exit 0.
MERGED_ROOT="$TMP_ROOT/merged"
make_repo "$MERGED_ROOT/main"
git -C "$MERGED_ROOT/main" worktree add -q -b issue-merged "$MERGED_ROOT/trees/issue-merged" main
merged_out=$(cd "$MERGED_ROOT/main" && "$WORKTREE_SCRIPT" remove ISSUE-MERGED 2>"$MERGED_ROOT/merged.err")
assert_eq "$merged_out" "Removed: $MERGED_ROOT/trees/issue-merged" "merged branch removal exits cleanly"
assert_path_absent "$MERGED_ROOT/trees/issue-merged" "merged branch worktree removed"
assert_branch_absent "$MERGED_ROOT/main" "issue-merged" "merged branch deleted"

# Unmerged branch: worktree is removed, branch remains, exit 1 includes diagnostic.
UNMERGED_ROOT="$TMP_ROOT/unmerged"
make_repo "$UNMERGED_ROOT/main"
git -C "$UNMERGED_ROOT/main" worktree add -q -b issue-unmerged "$UNMERGED_ROOT/trees/issue-unmerged" main
printf 'branch-only\n' >> "$UNMERGED_ROOT/trees/issue-unmerged/file.txt"
git -C "$UNMERGED_ROOT/trees/issue-unmerged" add file.txt
git -C "$UNMERGED_ROOT/trees/issue-unmerged" commit -q -m 'branch only'
set +e
unmerged_out=$(cd "$UNMERGED_ROOT/main" && "$WORKTREE_SCRIPT" remove ISSUE-UNMERGED 2>"$UNMERGED_ROOT/unmerged.err")
unmerged_code=$?
set -e
assert_eq "$unmerged_code" "1" "unmerged branch removal exits nonzero"
assert_eq "$unmerged_out" "Removed: $UNMERGED_ROOT/trees/issue-unmerged" "unmerged branch still reports removed worktree"
assert_path_absent "$UNMERGED_ROOT/trees/issue-unmerged" "unmerged branch worktree removed"
assert_branch_exists "$UNMERGED_ROOT/main" "issue-unmerged" "unmerged branch retained"
assert_contains "$(cat "$UNMERGED_ROOT/unmerged.err")" "could not delete local branch 'issue-unmerged'" "unmerged branch diagnostic names failed cleanup step"
assert_contains "$(cat "$UNMERGED_ROOT/unmerged.err")" "branch -D \"issue-unmerged\"" "unmerged branch diagnostic gives manual recovery command"

# Relative symlinks: create link inside worktree with target resolved from the
# worktree path, not from the main checkout.
LINK_ROOT="$TMP_ROOT/links"
make_repo "$LINK_ROOT/main"
printf 'agents\n' > "$LINK_ROOT/main/AGENTS.md"
mkdir -p "$LINK_ROOT/main/.claude/agents"
printf '{"hooks":{}}\n' > "$LINK_ROOT/main/.claude/settings.json"
git -C "$LINK_ROOT/main" add AGENTS.md .claude/settings.json
git -C "$LINK_ROOT/main" commit -q -m agents
cat > "$LINK_ROOT/main/.env.local" <<'ENV'
WORKTREE_SYMLINKS=".env.local .claude/settings.json .claude/agents"
WORKTREE_RELATIVE_SYMLINKS=".claude/CLAUDE.md=../AGENTS.md"
ENV
git -C "$LINK_ROOT/main" worktree add -q -b issue-links "$LINK_ROOT/trees/issue-links" main
links_out=$(cd "$LINK_ROOT/main" && "$WORKTREE_SCRIPT" fix-links "$LINK_ROOT/trees/issue-links")
assert_eq "$links_out" "Restored symlinks in $LINK_ROOT/trees/issue-links" "fix-links reports restored symlinks"
assert_symlink_target "$LINK_ROOT/trees/issue-links/.env.local" "$LINK_ROOT/main/.env.local" ".env.local symlink points to main checkout"
assert_symlink_target "$LINK_ROOT/trees/issue-links/.claude/settings.json" "$LINK_ROOT/main/.claude/settings.json" "configured file symlink points to main checkout"
assert_git_status_clean_for_path "$LINK_ROOT/trees/issue-links" ".claude/settings.json" "configured tracked file symlink is hidden from git status"
assert_symlink_target "$LINK_ROOT/trees/issue-links/.claude/agents" "$LINK_ROOT/main/.claude/agents" "configured dir symlink points to main checkout"
assert_symlink_target "$LINK_ROOT/trees/issue-links/.claude/CLAUDE.md" "../AGENTS.md" "relative symlink keeps worktree-local AGENTS target"

# .env.local is not special-cased. It is only linked when listed in
# WORKTREE_SYMLINKS.
NOENV_ROOT="$TMP_ROOT/noenv"
make_repo "$NOENV_ROOT/main"
cat > "$NOENV_ROOT/main/.env.local" <<'ENV'
WORKTREE_SYMLINKS=""
ENV
git -C "$NOENV_ROOT/main" worktree add -q -b issue-noenv "$NOENV_ROOT/trees/issue-noenv" main
noenv_out=$(cd "$NOENV_ROOT/main" && "$WORKTREE_SCRIPT" fix-links "$NOENV_ROOT/trees/issue-noenv")
assert_eq "$noenv_out" "Restored symlinks in $NOENV_ROOT/trees/issue-noenv" "fix-links works without .env.local symlink"
assert_path_absent "$NOENV_ROOT/trees/issue-noenv/.env.local" ".env.local not linked unless configured"

# WORKTREE_BASE_DIR can be set in .env or .env.local. Relative values resolve
# from the main checkout; .env.local overrides .env and trailing slashes are
# ignored.
CONFIG_ROOT="$TMP_ROOT/config"
make_repo "$CONFIG_ROOT/main"
cat > "$CONFIG_ROOT/main/.env" <<'ENV'
WORKTREE_BASE_DIR="../from-env"
ENV
config_path=$(cd "$CONFIG_ROOT/main" && "$WORKTREE_SCRIPT" path ISSUE-CONFIG)
assert_eq "$config_path" "$CONFIG_ROOT/from-env/issue-config" ".env WORKTREE_BASE_DIR controls path"
cat > "$CONFIG_ROOT/main/.env.local" <<ENV
WORKTREE_BASE_DIR="$CONFIG_ROOT/from-local/"
ENV
config_local_path=$(cd "$CONFIG_ROOT/main" && "$WORKTREE_SCRIPT" path ISSUE-CONFIG)
assert_eq "$config_local_path" "$CONFIG_ROOT/from-local/issue-config" ".env.local WORKTREE_BASE_DIR overrides .env"

# create uses the configured worktree parent directory, not only the path helper.
CREATE_ROOT="$TMP_ROOT/create-custom"
make_repo "$CREATE_ROOT/main"
cat > "$CREATE_ROOT/main/.env" <<'ENV'
WORKTREE_BASE_DIR="../custom-trees"
ENV
custom_create_out=$(cd "$CREATE_ROOT/main" && "$WORKTREE_SCRIPT" create ISSUE-CUSTOM --from main)
assert_eq "$custom_create_out" "$CREATE_ROOT/custom-trees/issue-custom" "create reports configured WORKTREE_BASE_DIR path"
assert_git_worktree "$CREATE_ROOT/custom-trees/issue-custom" "create writes worktree under configured WORKTREE_BASE_DIR"

echo
printf 'pass: %d   fail: %d\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
