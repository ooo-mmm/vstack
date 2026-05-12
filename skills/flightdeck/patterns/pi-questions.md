# Pi structured question routing

Pi's `pi-questions` extension renders questions inline in the editor area and exposes the same pending request through `pi-session-bridge`. Flightdeck should use the bridge contract, not tmux key driving, whenever bridge metadata is available.

## Wake event

`flightdeck-daemon` subscribes with `pi-bridge stream --pid <PID>`. When `pi-questions` opens a request, `pi-session-bridge` emits:

```json
{
  "type": "event",
  "event": "question",
  "data": {
    "action": "opened",
    "requestId": "que_...",
    "request": {
      "id": "que_...",
      "header": "Choose next action",
      "questions": [
        {
          "header": "Scope",
          "question": "How should I proceed?",
          "options": [{ "label": "Use current branch", "description": "..." }],
          "multiple": false,
          "allowCustom": true,
          "customLabel": "Type custom answer"
        }
      ]
    }
  }
}
```

The daemon normalizes this to a canonical `pi-question` wake event with `question` set to the request payload.

`pi-agents-tmux` may also emit `subagent-completion` custom messages from inner persistent panes. The daemon treats blocked/failed/needs-completion completions as `pi-subagent-completion` advisory wake events and logs successful completions without waking. Flightdeck must re-poll the outer orchestration pane and let that orchestrator consume the inner result. Do not call `subagent`, `steer_subagent`, or `get_subagent_result` for the orchestrator's inner panes from Flightdeck, and never target them by shared cwd/session metadata. If the orchestrator needs a decision about an inner result, it will surface a normal outer `pi-question` or prompt; answer that outer prompt only.

## Answering

Use `pane-respond` with `--harness pi`:

```bash
# Pick one listed option label.
pane-respond <pane> --harness pi --question que_... --answer "Use current branch"

# Multi-select listed labels when the tab has multiple=true.
pane-respond <pane> --harness pi --question que_... --answer-multi "Label A,Label B"

# Free-form custom text only when the target question has allowCustom=true.
pane-respond <pane> --harness pi --question que_... --answer-text "Use CC-1234 and keep the current branch"

# Full multi-tab answer matrix: one inner array per tab, labels or allowed custom text.
pane-respond <pane> --harness pi --question que_... --answers-json '[["Use current branch"],["Use CC-1234"]]'

# Cancel without answering.
pane-respond <pane> --harness pi --question que_... --reject
```

`pane-respond` routes to `pi-bridge answer --answers '[[...]]'` or `pi-bridge reject`; no tmux `send-keys`, tabbing, or inline-editor manipulation is involved on the success path.

## Selection policy

- For normal option picks, `--answer` values must exactly match labels from `question.questions[i].options[].label`.
- Use `--answer-multi` only when that tab has `multiple=true`.
- Use `--answer-text` only when that tab has `allowCustom=true`; this is the bridge equivalent of tabbing to the custom/free-type row and typing in the inline editor.
- Use `--answers-json` for multi-tab requests. The JSON must contain one inner answer array per request tab, e.g. `[["Label A"],["custom text"]]`. Pi's synthetic `Confirm`/`Submit` UI tab is not part of `question.questions[]`; never include an extra answer array for it.
- If bridge metadata is missing and fallback tmux driving is unavoidable, use `--keys-allow-tmux` deliberately and mirror the UI mechanics: `Tab`/`Left`/`Right` switch through request tabs plus the synthetic `Confirm`/`Submit` tab, `Up`/`Down` move rows, single-select `Enter` confirms and advances, multi-select `Enter` or `Space` toggles the highlighted row, the synthetic `Confirm`/`Submit` tab's `Enter` submits, and `Escape` cancels or leaves text input.

## Pi slash-command grammar

- Pi only expands `/skill:<name>` (via `_expandSkillCommand`) and explicitly `pi.registerCommand`-registered names. Bare `/<skill-name>` is **not** auto-aliased and falls through to the LLM as raw text.
- `pi.sendUserMessage()` deliberately sets `expandPromptTemplates: false`, bypassing slash-command and skill expansion.
- `pi-bridge send` compensates mid-session with hybrid dispatch: `/skill:<name>` and prompt templates expand client-side before `sendUserMessage`; extension/TUI commands paste into the target Pi pane with `tmux send-keys -l` + Enter; plain text stays on raw `sendUserMessage`.
- Spawn commands can still use `pi '/skill:<name> ...'` (see `open-terminal`) because Pi's CLI initial prompt goes through the native expansion path. Mid-session flightdeck daemon wakes for Pi now use `pi-bridge send "/skill:flightdeck watch --from-daemon"`.
