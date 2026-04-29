#!/usr/bin/env bash
# Path resolvers + helper functions for the pi Session Bridge adapter.
#
# Pi bridge is a vstack-vendored pi-extension package living at
# ~/.pi/agent/packages/pi-session-bridge with the `pi-bridge` CLI
# symlinked at ~/.pi/agent/bin/pi-bridge. When a pi process starts
# with the bridge package loaded (default vstack pi config), the
# bridge writes:
#   ${PI_BRIDGE_DIR:-/tmp/pi-session-bridge-$UID}/instances/<pid>.json
#   ${PI_BRIDGE_DIR}/pi-<pid>.sock
# Both 0700/0600 — single-user-on-machine isolation only.
#
# Sourced by open-terminal (post-spawn discovery), pane-registry
# (auto-load metadata), pane-respond + pane-poll (read bridge
# metadata), flightdeck-daemon (per-pane stream subscriber).

# shellcheck source=daemon-paths.sh
source "$(dirname "${BASH_SOURCE[0]}")/daemon-paths.sh"

pi_spawn_file()    { echo "$(fd_resolve_state_dir)/pi-spawn-$1.json"; }

pi_pane_id_safe() {
  local id="$1"
  echo "${id#%}"
}

pi_subscriber_pid_file() { echo "$(fd_resolve_state_dir)/fd-pi-subscriber-$(pi_pane_id_safe "$1").pid"; }

# Resolve the pi-bridge CLI. Prefer PATH; fall back to the canonical
# vstack install path. Empty stdout + non-zero exit when not found.
pi_resolve_bridge_bin() {
  local p
  p=$(command -v pi-bridge 2>/dev/null || true)
  if [[ -n "$p" && -x "$p" ]]; then
    echo "$p"
    return 0
  fi
  if [[ -x "$HOME/.pi/agent/bin/pi-bridge" ]]; then
    echo "$HOME/.pi/agent/bin/pi-bridge"
    return 0
  fi
  return 1
}

# Resolve the pi binary similarly.
pi_resolve_pi_bin() {
  if [[ -x /usr/bin/pi ]]; then
    echo "/usr/bin/pi"
    return 0
  fi
  local p
  p=$(type -P pi 2>/dev/null || true)
  if [[ -n "$p" && -x "$p" ]]; then
    echo "$p"
    return 0
  fi
  return 1
}

# Resolve the path to the session-bridge extension. We pass this as
# `-e <PATH>` to pi so the bridge auto-loads regardless of whether
# the user's settings.json has the package registered (vstack install
# adds it, but the array can drift).
pi_resolve_bridge_extension() {
  local p="$HOME/.pi/agent/packages/pi-session-bridge/extensions/session-bridge.ts"
  if [[ -f "$p" ]]; then
    echo "$p"
    return 0
  fi
  return 1
}

# Find the latest pi bridge pid whose cwd matches the given worktree.
# Polls `pi-bridge list --bridge-dir <dir>` (with optional override),
# selects the entry whose cwd matches absolute worktree path. Returns
# pid on success.
pi_discover_pid() {
  local wt_path="$1"
  local timeout_secs="${2:-30}"
  local bin
  bin=$(pi_resolve_bridge_bin) || return 1
  local abs_wt
  abs_wt=$(cd "$wt_path" && pwd)
  local deadline=$((SECONDS + timeout_secs))
  while (( SECONDS < deadline )); do
    # `pi-bridge list --json` returns an array of {pid, cwd, sessionId, ...}
    local out
    out=$("$bin" list --json 2>/dev/null || echo "[]")
    if [[ -n "$out" ]]; then
      local pid
      pid=$(jq -r --arg dir "$abs_wt" '
        ( . // [] )
        | map(select((.cwd // "") == $dir))
        | sort_by(.startedAt // .started_at // 0)
        | last
        | (.pid // empty)
      ' <<< "$out" 2>/dev/null)
      if [[ -n "$pid" && "$pid" != "null" ]]; then
        echo "$pid"
        return 0
      fi
    fi
    sleep 0.5
  done
  return 1
}

# Stale check: pid alive + socket exists + protocol matches.
# Returns 0 if bridge metadata is fresh, non-zero if stale.
pi_bridge_is_fresh() {
  local pid="$1"
  local socket="$2"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  [[ -S "$socket" ]] || return 1
  local bin; bin=$(pi_resolve_bridge_bin) || return 1
  local proto
  proto=$("$bin" state --pid "$pid" 2>/dev/null \
    | jq -r '.data.protocol // ""' 2>/dev/null)
  [[ "$proto" == "pi-session-bridge.v1" ]]
}

# jq filter that extracts the last assistant message text from
# `pi-bridge history` output. Pi events shape:
#   {type:"event", event:"message_update", data:{message:{role:"assistant",
#    content:[{type:"text", text:"..."}], stopReason:"stop"}}}
PI_LAST_ASSISTANT_JQ='
  ( .data.events // [] )
  | map(select(.data.message.role == "assistant" and (.data.message.stopReason // "") != ""))
  | last
  | if . == null then ""
    else
      ( .data.message.content // [] )
      | (if type == "array" then map(select(.type == "text") | .text // "") | join("") else . end)
    end
'
