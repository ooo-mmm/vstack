#!/bin/bash
# GitHub API - Common functions via gh CLI
# Source this file in command scripts

set -euo pipefail

# Configuration
DEFAULT_FORMAT="safe" # safe, raw

json_or_default() {
    local fallback="$1"
    local expected_type="$2"
    shift 2

    local output=""
    if ! output=$("$@" 2>&1); then
        printf 'Command failed: %s\n' "$*" >&2
        if [[ -n "$output" ]]; then
            printf '%s\n' "$output" >&2
        fi
        printf '%s' "$fallback"
        return 1
    fi

    if ! jq -e --arg type "$expected_type" 'type == $type' >/dev/null 2>&1 <<<"$output"; then
        printf 'Invalid JSON response (expected %s): %s\n' "$expected_type" "$*" >&2
        if [[ -n "$output" ]]; then
            printf '%s\n' "$output" >&2
        fi
        printf '%s' "$fallback"
        return 2
    fi

    printf '%s' "$output"
}

# Internal lib directory (underscore prefix avoids overwriting caller's SCRIPT_DIR)
_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"

# Get repository owner and name from current git context
get_repo_info() {
    local info
    info=$(gh repo view --json owner,name 2>/dev/null) || {
        echo '{"error": "Not in a GitHub repository or gh not authenticated"}' >&2
        return 1
    }
    echo "$info"
}

# Extract owner from repo info
get_owner() {
    local repo_info="${1:-}"
    if [ -z "$repo_info" ]; then
        repo_info=$(get_repo_info) || return 1
    fi
    echo "$repo_info" | jq -r '.owner.login'
}

# Extract repo name from repo info
get_repo() {
    local repo_info="${1:-}"
    if [ -z "$repo_info" ]; then
        repo_info=$(get_repo_info) || return 1
    fi
    echo "$repo_info" | jq -r '.name'
}

# Collect local branch names for default PR list scoping.
# Shared refs mean branches checked out in linked worktrees also appear here.
get_local_branch_names_json() {
    local branches
    branches=$(git for-each-ref refs/heads --format='%(refname:short)' 2>/dev/null || true)

    if [ -z "$branches" ]; then
        printf '[]'
        return 0
    fi

    printf '%s\n' "$branches" | jq -R . | jq -s 'map(select(length > 0))'
}

# Default PR list scope:
#   1. repo-local branches (plain issue branches like proj-117)
#   2. current user's namespaced branches (user/proj-117)
filter_prs_to_default_scope() {
    local prs_json="$1"
    local gh_user="${2:-}"
    local local_branches_json="${3:-[]}"

    jq \
        --arg gh_user "$gh_user" \
        --argjson local_branches "$local_branches_json" \
        '
        map(
            .headRefName as $head |
            select(
                (($local_branches | index($head)) != null) or
                ($gh_user != "" and ($head | startswith($gh_user + "/")))
            )
        )
        ' <<<"$prs_json"
}

# Check gh CLI authentication
check_gh_auth() {
    if ! gh auth status &>/dev/null; then
        echo '{"error": "gh CLI not authenticated. Run: gh auth login"}' >&2
        return 1
    fi
}

# Execute GraphQL query with error handling and retry
# Usage: graphql_query "query { ... }" '{"var": "value"}'
# Or with -F variables: graphql_query "query($x: Type!) { ... }" -F x="value"
gh_graphql() {
    local query="$1"
    shift
    local max_retries=3
    local retry_delay=1
    local attempt=1

    check_gh_auth || return 1

    while [ $attempt -le $max_retries ]; do
        local response
        local stderr_output
        local exit_code=0

        # Execute query - capture stdout and stderr separately
        response=$(gh api graphql -f query="$query" "$@" 2>/dev/null) || exit_code=$?

        if [ $exit_code -eq 0 ]; then
            # Check for GraphQL errors
            local errors
            errors=$(echo "$response" | jq -r '.errors // empty' 2>/dev/null)
            if [ -n "$errors" ] && [ "$errors" != "null" ]; then
                local error_type error_msg
                error_type=$(echo "$response" | jq -r '.errors[0].type // ""')
                error_msg=$(echo "$response" | jq -r '.errors[0].message // "Unknown GraphQL error"')

                # Translate common errors
                case "$error_type" in
                NOT_FOUND)
                    echo '{"error": "Not found"}' >&2
                    ;;
                *)
                    echo "{\"error\": \"GraphQL: $error_msg\"}" >&2
                    ;;
                esac
                return 1
            fi
            # Success - return data
            echo "$response" | jq -c '.data'
            return 0
        fi

        # Non-zero exit - check if we got JSON with errors
        if [ -n "$response" ]; then
            local errors
            errors=$(echo "$response" | jq -r '.errors // empty' 2>/dev/null)
            if [ -n "$errors" ] && [ "$errors" != "null" ]; then
                local error_type error_msg
                error_type=$(echo "$response" | jq -r '.errors[0].type // ""')
                error_msg=$(echo "$response" | jq -r '.errors[0].message // "Unknown error"')

                case "$error_type" in
                NOT_FOUND)
                    echo '{"error": "Not found"}' >&2
                    ;;
                *)
                    echo "{\"error\": \"$error_msg\"}" >&2
                    ;;
                esac
                return 1
            fi
        fi

        # Handle HTTP/network errors
        if [ $attempt -lt $max_retries ]; then
            sleep $retry_delay
            retry_delay=$((retry_delay * 2))
            attempt=$((attempt + 1))
            continue
        fi

        echo '{"error": "GitHub API request failed"}' >&2
        return 1
    done
}

# Execute REST API call with error handling
# Usage: gh_rest "repos/{owner}/{repo}/pulls/123"
gh_rest() {
    local endpoint="$1"
    shift
    local max_retries=3
    local retry_delay=1
    local attempt=1

    check_gh_auth || return 1

    while [ $attempt -le $max_retries ]; do
        local response
        local exit_code=0

        response=$(gh api "$endpoint" "$@" 2>&1) || exit_code=$?

        if [ $exit_code -eq 0 ]; then
            echo "$response"
            return 0
        fi

        # Handle errors
        case "$response" in
        *"401"* | *"Unauthorized"*)
            echo '{"error": "GitHub authentication failed"}' >&2
            return 1
            ;;
        *"403"* | *"rate limit"*)
            if [ $attempt -lt $max_retries ]; then
                sleep $retry_delay
                retry_delay=$((retry_delay * 2))
                attempt=$((attempt + 1))
                continue
            fi
            echo '{"error": "GitHub rate limited"}' >&2
            return 1
            ;;
        *"404"* | *"Not Found"*)
            echo '{"error": "Resource not found"}' >&2
            return 1
            ;;
        *)
            if [ $attempt -lt $max_retries ]; then
                sleep $retry_delay
                retry_delay=$((retry_delay * 2))
                attempt=$((attempt + 1))
                continue
            fi
            local clean_error
            clean_error=$(echo "$response" | head -c 200 | tr '\n' ' ')
            echo "{\"error\": \"$clean_error\"}" >&2
            return 1
            ;;
        esac
    done
}

# Parse --format argument from args
# Usage: remaining_args=$(parse_format_arg "$@")
# Sets FORMAT global variable
parse_format_arg() {
    FORMAT="${DEFAULT_FORMAT}"
    local remaining_args=()

    while [[ $# -gt 0 ]]; do
        case "$1" in
        --format)
            FORMAT="$2"
            shift 2
            ;;
        --format=*)
            FORMAT="${1#--format=}"
            shift
            ;;
        *)
            remaining_args+=("$1")
            shift
            ;;
        esac
    done

    # Validate format
    case "$FORMAT" in
    safe | raw) ;;
    *)
        echo "{\"error\": \"Invalid format: $FORMAT. Use: safe, raw\"}" >&2
        return 1
        ;;
    esac

    echo "${remaining_args[@]:-}"
}

# Load and validate bot token from .env.local or .env
# Supports direct tokens (ghp_*, gho_*, ghs_*, ghr_*) and 1Password references (op://...)
# Returns: token string if valid, empty string if not configured/invalid
# Outputs: diagnostic messages to stderr
load_bot_token() {
    local token=""

    # Load from .env.local first, fall back to .env
    if [ -f "$PROJECT_ROOT/.env.local" ]; then
        # shellcheck disable=SC1090
        source "$PROJECT_ROOT/.env.local"
        token="${GH_BOT_TOKEN:-}"
    elif [ -f "$PROJECT_ROOT/.env" ]; then
        # shellcheck disable=SC1090
        source "$PROJECT_ROOT/.env"
        token="${GH_BOT_TOKEN:-}"
    fi

    # Empty token - not configured
    if [ -z "$token" ]; then
        return 0
    fi

    # Check for 1Password reference
    if [[ "$token" == op://* ]]; then
        if command -v op &>/dev/null; then
            local resolved
            if resolved=$(op read "$token" 2>/dev/null); then
                token="$resolved"
            else
                echo "Warning: Failed to resolve 1Password reference. Run: op signin" >&2
                return 0
            fi
        else
            echo "Warning: GH_BOT_TOKEN is a 1Password reference but 'op' CLI not found" >&2
            echo "  Install: https://developer.1password.com/docs/cli/get-started/" >&2
            return 0
        fi
    fi

    # Validate GitHub token format
    # Classic: ghp_, gho_, ghs_, ghr_
    # Fine-grained: github_pat_
    if [[ "$token" =~ ^gh[pors]_ ]] || [[ "$token" =~ ^github_pat_ ]]; then
        echo "$token"
        return 0
    fi

    # Invalid format
    echo "Warning: GH_BOT_TOKEN has invalid format (expected ghp_*, gho_*, ghs_*, ghr_*, or github_pat_*)" >&2
    echo "  Current value starts with: ${token:0:4}..." >&2
    echo "  Fix: Update .env.local with a valid GitHub token" >&2
    return 0
}

# Get formal review verdict from GitHub API (primary source - structured data)
# The bot submits a formal GitHub review (APPROVED/CHANGES_REQUESTED) which is
# the most reliable verdict signal. Falls back to empty string if no formal review.
# Usage: get_formal_review_verdict <PR#> [bot-login]
# Returns: "approved", "changes", or "" (no formal review found)
get_formal_review_verdict() {
    local pr="$1"
    local bot_user="${2:-${GH_BOT_USERNAME:-review-bot[bot]}}"
    local review_state
    review_state=$(gh api "repos/{owner}/{repo}/pulls/$pr/reviews" \
        --jq "[.[] | select(.user.login == \"$bot_user\")] | last | .state // empty" 2>/dev/null || echo "")
    case "$review_state" in
    APPROVED) echo "approved" ;;
    CHANGES_REQUESTED) echo "changes" ;;
    *) echo "" ;;
    esac
}

# Compute the verdict ("pending"|"approved"|"changes") from a sticky/review
# comment body. Mirrors the logic in commands/sticky-comment.sh — kept here so
# bot_review_status_compute and tests do not need to shell out.
compute_sticky_verdict_from_body() {
    local body="$1"
    local has_review_section
    has_review_section=$(printf '%s' "$body" | grep -ciE '## Review|### Inline|### Recommendation|Recommendation:|View job' || true)
    if [[ $has_review_section -eq 0 ]]; then
        local unchecked
        unchecked=$(printf '%s\n' "$body" | grep -c '^[[:space:]]*- \[ \]' || true)
        if [[ $unchecked -gt 0 ]]; then
            echo "pending"
            return 0
        fi
    fi
    local has_check has_approv has_warn has_changes
    has_check=$(printf '%s' "$body" | grep -c "✅" || true)
    has_approv=$(printf '%s' "$body" | grep -ci "approv" || true)
    has_warn=$(printf '%s' "$body" | grep -c "⚠️" || true)
    has_changes=$(printf '%s' "$body" | grep -ci "changes" || true)
    if [[ $has_check -gt 0 && $has_approv -gt 0 ]]; then
        if [[ $has_warn -gt 0 || $has_changes -gt 0 ]]; then
            echo "changes"
        else
            echo "approved"
        fi
    elif [[ $has_warn -gt 0 || $has_changes -gt 0 ]]; then
        echo "changes"
    else
        echo "pending"
    fi
}

# ---------------------------------------------------------------------------
# Multi-bot review signal abstraction
# ---------------------------------------------------------------------------
# Different bots signal review state differently:
#   - Claude-style: formal PR review (APPROVED|CHANGES_REQUESTED) + sticky
#                   "View job" comment with checklist + verdict text
#   - Codex-style:  reactions on the PR body or its earliest comment
#                   (👀 = reviewing/pending, 👍 = approved); inline review
#                   threads when changes are requested
#
# `bot_review_status_compute` derives a per-reviewer status from preloaded
# JSON inputs so the logic is unit-testable without hitting GitHub.
# `bot_review_status` is a thin wrapper that fetches the inputs via `gh`.

# Normalize a reaction `content` value across REST and GraphQL.
# REST returns: "+1", "-1", "laugh", "hooray", "confused", "heart", "rocket", "eyes"
# GraphQL returns: "THUMBS_UP", "THUMBS_DOWN", "LAUGH", "HOORAY", "CONFUSED", "HEART", "ROCKET", "EYES"
_normalize_reaction_content() {
    case "$1" in
        THUMBS_UP|"+1") echo "+1" ;;
        THUMBS_DOWN|"-1") echo "-1" ;;
        EYES|eyes) echo "eyes" ;;
        LAUGH|laugh) echo "laugh" ;;
        HOORAY|hooray) echo "hooray" ;;
        CONFUSED|confused) echo "confused" ;;
        HEART|heart) echo "heart" ;;
        ROCKET|rocket) echo "rocket" ;;
        *) echo "$1" ;;
    esac
}

# Compute per-reviewer status from preloaded JSON inputs.
#
# Args:
#   $1 reviewer login (e.g. "chatgpt-codex-connector[bot]")
#   $2 reviews JSON array (from /repos/{owner}/{repo}/pulls/{pr}/reviews)
#   $3 issue comments JSON array (from /repos/{owner}/{repo}/issues/{pr}/comments)
#   $4 PR body reactions JSON array (from /repos/{owner}/{repo}/issues/{pr}/reactions)
#   $5 reviewer's own first-comment reactions JSON array, or "[]"
#   $6 review threads JSON array — each thread {isResolved, isOutdated, comments:{nodes:[{author:{login}}]}}
#
# Decision order (signals always recorded regardless):
#   1. Reviewer has unresolved (current) inline threads → "changes"
#   2. Latest formal review APPROVED/CHANGES_REQUESTED   → that verdict
#   3. Sticky/View-job comment terminal verdict          → that verdict
#   4. 👍 reaction on PR body or own comment             → "approved"
#   5. 👀 reaction on PR body or own comment             → "pending"
#   6. Sticky present but parsed as pending              → "pending"
#   7. Otherwise                                         → "unknown"
#
# Output: single-line JSON object
#   {reviewer, status, signals, updated_at, unresolved_threads}
bot_review_status_compute() {
    local reviewer="$1"
    local reviews_json="${2:-[]}"
    local comments_json="${3:-[]}"
    local body_reactions="${4:-[]}"
    local own_reactions="${5:-[]}"
    local threads_json="${6:-[]}"

    [[ -z "$reviews_json" ]] && reviews_json='[]'
    [[ -z "$comments_json" ]] && comments_json='[]'
    [[ -z "$body_reactions" ]] && body_reactions='[]'
    [[ -z "$own_reactions" ]] && own_reactions='[]'
    [[ -z "$threads_json" ]] && threads_json='[]'

    local signals='[]'
    local status="unknown"
    local updated_at=""

    # --- formal review ---
    local formal_state formal_at
    formal_state=$(jq -r --arg u "$reviewer" \
        '[.[] | select(.user.login == $u)] | last | .state // empty' \
        <<<"$reviews_json" 2>/dev/null || echo "")
    formal_at=$(jq -r --arg u "$reviewer" \
        '[.[] | select(.user.login == $u)] | last | .submitted_at // .created_at // empty' \
        <<<"$reviews_json" 2>/dev/null || echo "")
    case "$formal_state" in
        APPROVED)
            signals=$(jq -c '. + ["formal_review:approved"]' <<<"$signals")
            status="approved"
            [[ -n "$formal_at" ]] && updated_at="$formal_at"
            ;;
        CHANGES_REQUESTED)
            signals=$(jq -c '. + ["formal_review:changes_requested"]' <<<"$signals")
            status="changes"
            [[ -n "$formal_at" ]] && updated_at="$formal_at"
            ;;
        COMMENTED)
            signals=$(jq -c '. + ["formal_review:commented"]' <<<"$signals")
            ;;
    esac

    # --- sticky / review summary comment ---
    local sticky_obj sticky_body sticky_at
    sticky_obj=$(jq -c --arg u "$reviewer" '
        [.[] | select(.user.login == $u)] |
        ((map(select(.body | test("View job"; "i"))) | first) //
         (map(select(.body | test("## Review|### Inline|### Recommendation"; "i"))) | last) //
         empty)
    ' <<<"$comments_json" 2>/dev/null || echo "null")
    if [[ -n "$sticky_obj" && "$sticky_obj" != "null" ]]; then
        sticky_body=$(jq -r '.body // ""' <<<"$sticky_obj")
        sticky_at=$(jq -r '.updated_at // .created_at // ""' <<<"$sticky_obj")
        local sv
        sv=$(compute_sticky_verdict_from_body "$sticky_body")
        signals=$(jq -c --arg s "sticky:$sv" '. + [$s]' <<<"$signals")
        if [[ "$status" == "unknown" ]]; then
            case "$sv" in
                approved) status="approved"; updated_at="${updated_at:-$sticky_at}" ;;
                changes)  status="changes";  updated_at="${updated_at:-$sticky_at}" ;;
                pending)  status="pending";  updated_at="${updated_at:-$sticky_at}" ;;
            esac
        fi
    fi

    # --- reactions (Codex-style) ---
    local has_eyes=0 has_thumbs=0
    local content normalized
    while IFS= read -r content; do
        [[ -z "$content" ]] && continue
        normalized=$(_normalize_reaction_content "$content")
        case "$normalized" in
            eyes) has_eyes=1 ;;
            "+1") has_thumbs=1 ;;
        esac
    done < <(jq -r --arg u "$reviewer" '
        [.[] | select(.user.login == $u) | .content] | unique | .[]
    ' <<<"$body_reactions" 2>/dev/null)

    while IFS= read -r content; do
        [[ -z "$content" ]] && continue
        normalized=$(_normalize_reaction_content "$content")
        case "$normalized" in
            eyes) has_eyes=1 ;;
            "+1") has_thumbs=1 ;;
        esac
    done < <(jq -r --arg u "$reviewer" '
        [.[] | select(.user.login == $u) | .content] | unique | .[]
    ' <<<"$own_reactions" 2>/dev/null)

    if [[ $has_eyes -eq 1 ]]; then
        signals=$(jq -c '. + ["reaction:eyes"]' <<<"$signals")
    fi
    if [[ $has_thumbs -eq 1 ]]; then
        signals=$(jq -c '. + ["reaction:+1"]' <<<"$signals")
    fi

    # --- unresolved review threads authored by this reviewer ---
    local unresolved
    unresolved=$(jq --arg u "$reviewer" '
        [.[]
         | select((.isResolved // false) == false)
         | select((.isOutdated // false) == false)
         | select([.comments.nodes[]?.author.login // empty] | any(. == $u))
        ] | length
    ' <<<"$threads_json" 2>/dev/null || echo 0)
    [[ -z "$unresolved" || "$unresolved" == "null" ]] && unresolved=0
    if [[ "$unresolved" -gt 0 ]]; then
        signals=$(jq -c --arg s "inline:$unresolved" '. + [$s]' <<<"$signals")
    fi

    # --- final status resolution ---
    # Unresolved-by-reviewer ALWAYS forces "changes" — this is the Codex path
    # where the bot signals fix requests via inline threads only. For Claude
    # this matches the existing behavior because formal CHANGES_REQUESTED is
    # already "changes".
    if [[ "$unresolved" -gt 0 ]]; then
        status="changes"
    elif [[ "$status" == "unknown" ]]; then
        if [[ $has_thumbs -eq 1 ]]; then
            status="approved"
        elif [[ $has_eyes -eq 1 ]]; then
            status="pending"
        fi
    fi

    jq -n -c \
        --arg reviewer "$reviewer" \
        --arg status "$status" \
        --argjson signals "$signals" \
        --arg updated_at "$updated_at" \
        --argjson unresolved "$unresolved" \
        '{reviewer:$reviewer, status:$status, signals:$signals, updated_at:$updated_at, unresolved_threads:$unresolved}'
}

# Live wrapper: fetches all required inputs from GitHub and calls
# bot_review_status_compute. Returns the same JSON shape.
bot_review_status() {
    local pr="$1"
    local reviewer="$2"

    local reviews comments body_reactions own_reactions threads first_comment_id

    reviews=$(gh api "repos/{owner}/{repo}/pulls/$pr/reviews" 2>/dev/null || echo "[]")
    comments=$(gh api "repos/{owner}/{repo}/issues/$pr/comments" 2>/dev/null || echo "[]")
    body_reactions=$(gh api "repos/{owner}/{repo}/issues/$pr/reactions" 2>/dev/null || echo "[]")

    first_comment_id=$(jq -r --arg u "$reviewer" \
        '[.[] | select(.user.login == $u)] | first | .id // empty' \
        <<<"$comments" 2>/dev/null || echo "")
    if [[ -n "$first_comment_id" ]]; then
        own_reactions=$(gh api "repos/{owner}/{repo}/issues/comments/$first_comment_id/reactions" 2>/dev/null || echo "[]")
    else
        own_reactions="[]"
    fi

    # Fetch review threads via GraphQL (REST does not expose isResolved cleanly)
    local repo_info owner repo
    repo_info=$(get_repo_info 2>/dev/null) || repo_info=""
    if [[ -n "$repo_info" ]]; then
        owner=$(get_owner "$repo_info")
        repo=$(get_repo "$repo_info")
        local query='
query($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100) {
        nodes {
          isResolved
          isOutdated
          comments(first: 5) { nodes { author { login } } }
        }
      }
    }
  }
}'
        threads=$(gh_graphql "$query" -F owner="$owner" -F repo="$repo" -F pr="$pr" 2>/dev/null \
            | jq -c '.repository.pullRequest.reviewThreads.nodes // []' 2>/dev/null || echo "[]")
    else
        threads="[]"
    fi

    bot_review_status_compute "$reviewer" "$reviews" "$comments" "$body_reactions" "$own_reactions" "$threads"
}

# Auto-detect bot reviewers — every "*[bot]" login that has signaled on the PR
# in any way (formal review, issue comment, or reaction on the PR body).
detect_bot_reviewers() {
    local pr="$1"
    {
        gh api "repos/{owner}/{repo}/pulls/$pr/reviews" \
            --jq '.[].user.login | select(endswith("[bot]"))' 2>/dev/null || true
        gh api "repos/{owner}/{repo}/issues/$pr/comments" \
            --jq '.[].user.login | select(endswith("[bot]"))' 2>/dev/null || true
        gh api "repos/{owner}/{repo}/issues/$pr/reactions" \
            --jq '.[].user.login | select(endswith("[bot]"))' 2>/dev/null || true
    } | sort -u | grep -v '^$' || true
}

# Check if bot token is configured and valid
# Usage: check_bot_token [format]
# format: safe (default), text
check_bot_token() {
    local format="${1:-safe}"
    local token
    token=$(load_bot_token 2>/dev/null)

    case "$format" in
    safe | json | true) # "true" for backward compat with old boolean param
        if [ -n "$token" ]; then
            echo '{"configured": true, "valid": true}'
        else
            echo '{"configured": false, "valid": false}'
        fi
        ;;
    text | false) # "false" for backward compat
        if [ -n "$token" ]; then
            echo "configured"
        else
            echo "not configured"
        fi
        ;;
    *)
        echo "Error: Unknown format: $format. Use: safe, text" >&2
        return 1
        ;;
    esac
}

# Get PR number from current branch
get_current_pr() {
    local pr_json
    pr_json=$(gh pr view --json number 2>/dev/null) || {
        echo '{"error": "No PR found for current branch"}' >&2
        return 1
    }
    echo "$pr_json" | jq -r '.number'
}

# Resolve PR reference (number, branch, or current)
# Usage: resolve_pr_number "23" or "feature-branch" or ""
resolve_pr_number() {
    local ref="${1:-}"

    if [ -z "$ref" ]; then
        get_current_pr
        return
    fi

    # If numeric, return as-is
    if [[ "$ref" =~ ^[0-9]+$ ]]; then
        echo "$ref"
        return
    fi

    # Try to find PR by branch name
    local pr_json
    pr_json=$(gh pr view "$ref" --json number 2>/dev/null) || {
        echo "{\"error\": \"No PR found for: $ref\"}" >&2
        return 1
    }
    echo "$pr_json" | jq -r '.number'
}
