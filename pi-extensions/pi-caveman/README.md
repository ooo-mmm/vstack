# pi-caveman

Native Pi caveman communication mode: fewer output tokens, same technical accuracy.

## Commands

- `/caveman` — enable the configured default mode if off, otherwise show status.
- `/caveman lite|full|ultra|micro` — set mode for this session.
- `/caveman toggle` — toggle between the configured default mode and off.
- `/caveman off|stop|quit` — disable caveman mode.
- `/caveman status` — show current mode/source.

Command arguments support autocomplete.

## Modes

| Mode | Style | Example |
| --- | --- | --- |
| `lite` | Professional, full sentences, no filler/hedging. | "Your component re-renders because it creates a new object reference each render. Wrap it in `useMemo`." |
| `full` | Classic terse caveman. Drops articles; fragments OK. | "New object ref each render. Inline prop = re-render. Wrap in `useMemo`." |
| `ultra` | Maximum English compression with abbreviations/arrows. | "Inline obj prop → new ref → re-render. `useMemo`." |
| `micro` | Shortest prompt injection; compact caveman policy for token-sensitive sessions. | "Obj ref changes each render → re-render. Memoize." |

## Example

Normal:

> "The reason your React component is re-rendering is likely because you're creating a new object reference on each render cycle. When you pass an inline object as a prop, React's shallow comparison sees it as a different object every time, which triggers a re-render. I'd recommend using useMemo to memoize the object."

Caveman:

> "New object ref each render. Inline object prop = new ref = re-render. Wrap in `useMemo`."

## Behavior

The extension injects instructions in `before_agent_start`; it does not post-process model output. Mode persists in the Pi session via custom session entries and is restored from the active branch.

Settings are managed through vstack/Pi `settings.json` integration. Project settings override user settings.

Clarity/safety escape is implemented as prompt policy: destructive/security/clarification turns get explicit normal-clarity guidance while mode remains active for later turns when `resumeAfterClarityEscape` is enabled.

Deferred: `caveman-commit` and `caveman-review` helper commands.
