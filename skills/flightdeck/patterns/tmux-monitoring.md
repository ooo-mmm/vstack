# Tmux monitoring patterns

Pane targeting, bell handling, and capture-pane idioms for safely observing the per-issue panes spawned by orchestration.

## Pane-0 rule

**Always target the explicit pane index `<session>:<window>.0` for orchestrator-pane reads.**

`tmux capture-pane -t <session>:<window>` (no `.<pane>` suffix) defaults to the **currently active pane** of that window. When the per-issue agent inside a spawned window has itself spawned sub-agent panes (e.g., opencode's `Iced Task` sub-agent, claude code's parallel sub-agent panes, codex worker panes), the active pane is often one of those sub-agent panes — NOT the per-issue orchestrator's main TUI.

Capturing the wrong pane misses the per-issue orchestrator's prompt. Symptom: flightdeck thinks the issue is idle when it's actually waiting for a response.

### The rule

```bash
# WRONG — captures whatever pane happens to be active
tmux capture-pane -t HT:cc-463 -p

# RIGHT — captures the orchestrator pane explicitly
tmux capture-pane -t HT:cc-463.0 -p -S -200
```

### When pane 0 isn't the orchestrator

Some TUIs may lay out their main UI on a non-zero pane. At registry init, fingerprint each window's panes:

```bash
for pane_idx in $(tmux list-panes -t <session>:<window> -F '#{pane_index}'); do
  buf=$(tmux capture-pane -t <session>:<window>.$pane_idx -p -S -50)
  if echo "$buf" | grep -qE '(❯ |claude code|opencode|codex>|■■■)' ; then
    orchestrator_pane=$pane_idx
    break
  fi
done
```

Persist the resolved index per issue as `pane_target` in master state (e.g., `"pane_target": "HT:cc-463.0"`). Use it for every subsequent capture-pane and send-keys call on that issue.

If fingerprinting fails (no sentinel matches on any pane), default to pane 0 and log a warning. Pane 0 is right for opencode and claude code in standard layouts.

### Capture-pane scrollback depth

Use `-S -200` for prompt classification. This captures the last 200 lines, enough to see the full prompt (most TUI prompts are <30 lines) plus surrounding context. Going deeper is wasteful; going shallower can miss multi-screen prompts (e.g., multi-issue audit prompts).

```bash
tmux capture-pane -t <session>:<window>.0 -p -S -200
```

## Atomic bell clearing

After every response sent to a pane, clear the window's bell flag. Otherwise the user's tmux status bar continues to show "needs attention" for a prompt the master already handled.

### The chained-command idiom

```bash
ORIG=$(tmux display-message -p '#{window_id}')
tmux select-window -t <session>:<window> \; select-window -t $ORIG
```

The `\;` chains both `select-window` calls in a single tmux command. The client coalesces them; the intermediate state is never rendered. Result: the bell flag clears (because tmux clears flags on window-view) but the user sees no flicker, even if attached.

### Standard pattern after every response

```bash
# 1. Send the response
tmux send-keys -t <session>:<window>.0 "<RESPONSE>" Enter

# 2. Clear the bell atomically
ORIG=$(tmux display-message -p '#{window_id}')
tmux select-window -t <session>:<window> \; select-window -t $ORIG
```

Encoded in `scripts/pane-clear-bell` and called automatically by `scripts/pane-respond` after every send-keys.

## Window state flags reference

Built-in flags from `tmux list-windows`:

| Flag | Per-window field | Meaning |
|------|------------------|---------|
| `*` | `window_active` | Currently focused (only useful for "which is the user looking at") |
| `-` | `window_last_flag` | Last-focused (previous nav) |
| `#` | `window_bell_flag` | Bell character received → likely needs attention |
| `!` | `window_activity_flag` | Output activity since last view (requires `monitor-activity on`) |
| `~` | `window_silence_flag` | No output for N seconds (requires `monitor-silence N`) |

Flightdeck's primary signal is `window_bell_flag`. If a project has `monitor-silence` enabled, `window_silence_flag` is a useful secondary signal for detecting stuck panes.

Quick scan command:

```bash
tmux list-windows -t <session> -F '#{window_index}:#{window_name} bell=#{window_bell_flag} activity=#{window_activity_flag} silence=#{window_silence_flag}'
```

## Send-keys quirks to be aware of

- **Bracketed paste vs typing**: long inputs (rebase guidance payloads) should use `tmux load-buffer + paste-buffer` or `send-keys -l` to avoid keybinding interpretation in the receiving TUI.
- **Enter key**: `tmux send-keys ... Enter` is portable. `\n` in the payload string does NOT submit; the literal `Enter` token does.
- **Multi-line payloads**: prefer `load-buffer` + `paste-buffer` for anything over ~200 chars; long send-keys can be misinterpreted by some TUIs as paste-bracketed input.
