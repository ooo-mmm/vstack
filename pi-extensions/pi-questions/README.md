# pi-questions

![Questions workflow](https://raw.githubusercontent.com/vanillagreencom/vstack/main/pi-extensions/pi-questions/assets/questions-workflow.gif)

Structured inline questions for Pi. Multi-tab categories, free-form answers, and bridge-driven replies.

## Highlights

- `question` tool for multiple-choice question tabs with optional free-form answers.
- Editor-area UI by default; optional floating overlay.
- OpenCode-style question UI: tab hints, highlighted active rows, `Enter` confirms single-select choices, and `Enter` toggles multi-select choices.
- Compact answered tool output lists every category answer; `Ctrl+O` expands to show each question and presented answers with the selected choice marked.
- Wrapped option labels stay readable in narrow panes.
- `pi-session-bridge` integration lets external clients list, answer, and reject pending questions.
- `pi-qol` notification hook fires before prompts open.

## Install

Via [npm](https://www.npmjs.com/package/@vanillagreen/pi-questions):

```bash
pi install npm:@vanillagreen/pi-questions
```

Via [vstack](https://github.com/vanillagreencom/vstack):

```bash
cargo install --git https://github.com/vanillagreencom/vstack.git vstack
vstack add vanillagreencom/vstack --pi-extension pi-questions --harness pi -y
```

Restart Pi after installation.

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
      "multiple": false,
      "allowCustom": true,
      "customLabel": "Type issue ID"
    }
  ]
}
```

Result:

```json
{ "requestId": "que_example", "answers": [["Stop here"]] }
```

Cancelled:

```json
{ "requestId": "que_example", "cancelled": true }
```

Set `allowCustom: true` to add a free-type row. Optional fields: `customLabel`, `customPlaceholder`.

## Keys

| Key | Action |
| --- | --- |
| `←` / `→` or `Tab` / `Shift+Tab` | Switch tabs. Multi-question and multi-select prompts include a final `Confirm`/`Submit` tab for submission. |
| `↑` / `↓` | Move selection. |
| `Enter` on single-select | Confirm the highlighted answer and advance/submit. |
| `Enter` on multi-select | Toggle the highlighted answer. Use the `Confirm` tab to submit. |
| `Enter` on custom row | Open/submit inline text input. |
| `Space` | Also toggles multi-select rows. |
| `Esc` | Dismiss prompt, or leave custom text input. |

## Settings

All settings live in the extension manager under **Questions**.

| Setting | What it does |
| --- | --- |
| Question UI mode | `editor` replaces the input area; `overlay` uses a floating popup. |
| Overlay popup width | Overlay mode only. |
| Overlay popup max height | Overlay mode only. Number or percentage string. |
| Visible option rows | Rows shown before scrolling. |
| Default question header | Fallback title when a request has no header. |
| Bridge replies enabled | Allow `pi-session-bridge` to answer/reject pending questions. |

## Bridge control

Requires `pi-session-bridge`. From any shell:

```bash
pi-bridge questions
pi-bridge answer --request-id que_example --answers '[["Stop here"]]'
pi-bridge reject --request-id que_example
```
