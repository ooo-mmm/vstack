# pi-caveman

![/caveman command autocomplete](https://raw.githubusercontent.com/vanillagreencom/vstack/main/pi-extensions/pi-caveman/assets/command-autocomplete.png)

Native Pi caveman communication mode: fewer output tokens, same technical accuracy.

## Commands

| Command | Action |
| --- | --- |
| `/caveman` | Enable the configured default mode when off; otherwise show status. |
| `/caveman:lite\|full\|ultra\|micro` | Set the session mode. |
| `/caveman:toggle` | Toggle between off and the configured default mode. |
| `/caveman off` | Disable caveman mode. |
| `/caveman status` | Show current mode and source. |

Arguments support autocomplete.

## Modes

| Mode | Style |
| --- | --- |
| `lite` | Professional full sentences, but no filler or hedging. |
| `full` | Classic terse caveman; fragments are OK. |
| `ultra` | Maximum English compression with abbreviations and arrows. |
| `micro` | Shortest prompt injection for token-sensitive sessions. |

## Behavior

- The extension injects instructions in `before_agent_start`; it does not post-process model output.
- Mode persists in the Pi session and restores from the active branch.
- Settings live in Pi/vstack `settings.json`; project settings override user settings.
- The clarity/safety escape is prompt policy: destructive, security-sensitive, or ambiguous turns get explicit normal-clarity guidance while mode can remain active for later turns.
