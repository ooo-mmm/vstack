# pi-qol

Quality-of-life extension for Pi.

Features:

- Intercepts distinguishable `Shift+Enter` / `Shift+Return` in the prompt editor and inserts a newline.
- Provides a configurable fallback newline key (`ctrl+j` by default) for terminals/tmux setups that collapse modified Enter into plain Enter.
- Styles `[Image #1]`, `[Image #2]`, ... placeholders as chips in the editor when Pi inserts those placeholders.
- Exposes a settings contract for hiding the collapsed `Thinking...` placeholder. Current Pi extension APIs do not expose assistant-message renderer replacement, so this setting is visible but cannot yet change built-in assistant rendering.

Commands:

- `/qol status`
- `/qol attachments`
- `/qol reset`

Known limitation: Pi owns pending image attachment state and does not expose it to extensions. This package styles placeholder text only and does not mutate attachments.
