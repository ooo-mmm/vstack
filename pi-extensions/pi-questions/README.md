# pi-questions

Structured popup questions for Pi, with multi-tab categories and `pi-bridge` reply/reject support.

## What it provides

- `question` tool: asks the user one or more multiple-choice categories.
- `ctx.askQuestions(payload)`: extension API helper for other Pi extensions.
- Interactive popup with tabs, single-select and multi-select modes.
- Session-bridge integration: external controllers can list, answer, reject, and stream question events.

## Payload

```json
{
  "id": "que_example",
  "header": "Choose next action",
  "questions": [
    {
      "header": "Issue Missing",
      "question": "How should I proceed?",
      "options": [
        { "label": "Use current branch", "description": "Continue without a tracker issue." },
        { "label": "Stop here", "description": "Wait for operator guidance." }
      ],
      "multiple": false
    }
  ]
}
```

Result:

```json
{ "requestId": "que_example", "answers": [["Stop here"]] }
```

Cancellation/reject:

```json
{ "requestId": "que_example", "cancelled": true }
```

## Popup keys

- `←/→`: switch tabs
- `↑/↓` or `j/k`: move selection
- `Enter`: single-select picks row and advances; multi-select advances/submits
- `Space`: toggles row in multi-select tabs
- `Esc` / `Ctrl+C`: cancel the whole request

## Flightdeck-style bridge control

Requires `pi-session-bridge` in the same Pi runtime. The bridge stream emits question events:

```bash
pi-bridge stream --pid <PID>
```

List pending questions:

```bash
pi-bridge questions --pid <PID>
```

Answer a request:

```bash
pi-bridge answer --pid <PID> --request-id que_example --answers '[["Stop here"]]'
```

Reject a request:

```bash
pi-bridge reject --pid <PID> --request-id que_example
```
