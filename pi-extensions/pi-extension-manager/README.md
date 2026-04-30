# pi-extension-manager

Pi extension inventory and settings manager for vstack-installed packages.

Commands:

- `/extensions` — open the Extensions tab directly.
- `/settings extensions` — same target when Pi allows extension commands to handle `/settings`.
- `/settings` — vstack settings shell with General, Extensions, and Audit tabs when command shadowing is available.

Settings are persisted under `vstack.extensionManager` in Pi `settings.json` files so they do not collide with Pi's own top-level `extensions` array.

Known runtime limitation: Pi does not currently expose a public API to add a native tab to its built-in `/settings` UI or to unload already-loaded extension modules. This package provides a Pi-styled settings shell and edits settings so package/provider enable-disable takes effect after `/reload` or restart where live unloading is not possible. Tool enable-disable is applied live with `pi.setActiveTools()`.
