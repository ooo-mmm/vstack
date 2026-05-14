# pi-extension-manager

![Extension Manager browser and settings editor](https://raw.githubusercontent.com/vanillagreencom/vstack/main/pi-extensions/pi-extension-manager/assets/extension-manager.gif)

Package manager and settings editor for Pi packages installed by vstack, npm, git, or local path.

## Highlights

- Browse, enable, disable, update, and uninstall packages from one popup.
- Separate settings editor with one tab per package that exposes vstack settings from user/global and project scopes.
- Diagnostics view shows status, source, install method, versions, and update state.
- Optional notification at session start when newer versions are available.

## Install

Via [npm](https://www.npmjs.com/package/@vanillagreen/pi-extension-manager):

```bash
pi install npm:@vanillagreen/pi-extension-manager
```

Via [vstack](https://github.com/vanillagreencom/vstack):

```bash
cargo install --git https://github.com/vanillagreencom/vstack.git vstack
vstack add vanillagreencom/vstack --pi-extension pi-extension-manager --harness pi -y
```

Restart Pi after installation.

## Commands

| Command | Action |
| --- | --- |
| `/extensions` | Open the package manager. |
| `/extensions:settings` | Open the settings editor. |
| `/extensions:enable` | Recovery command when the manager is disabled. |

## Keys

- `alt+shift+e` or `F11` opens the package manager.
- `alt+shift+s` or `F12` opens the settings editor.
- In the package manager: `alt+x` enables/disables, `alt+u` updates, `alt+d` uninstalls, `alt+a` opens diagnostics. `backspace` returns to the list from diagnostics.
- In the settings editor: type to filter, `Enter` to toggle/edit, `Esc` to cancel. Inline editors support `←`/`→`, `Home`/`End`, `alt+←`/`alt+→` word movement, `Backspace`/`Delete`, and `Ctrl+U` to clear.

Status icons: `●` active, `○` inactive, `×` broken. Packages with newer versions show `Update Needed`.

## Settings

Open `/extensions:settings`; settings appear under the **Extension Manager** tab.

| Setting | What it does |
| --- | --- |
| Enable manager UI | Expose `/extensions` and the manager UI. `/extensions:enable` is always available as recovery. |
| Default save scope | Where setting edits are written when scope is ambiguous (`project` or `user`). |
| Notify on extension updates | Post a one-line notification at session start listing extensions with newer versions. |

## Notes

Package enable/disable and updates take effect after `/reload` or restart — Pi doesn't currently support unloading already-loaded extensions.
