# pi-task-panel

Persistent structured task panel above the Pi editor.

Commands include `/todo add`, `/todo start`, `/todo done`, `/todo drop`, `/todo rm`, `/todo clear-completed`, `/todo hide`, `/todo show`, `/todo compact`, `/todo expand`, `/todo edit`, `/todo export`, `/todo import`, and `/todo manage`.

The model can update tasks with the `todo_write` tool.

Keyboard conflict: Pi uses `Ctrl+T` for thinking visibility. This package always registers the alternate shortcut from settings (`ctrl+shift+t` by default). It registers `Ctrl+T` only when `takeoverCtrlT` is enabled in the extension manager and Pi is reloaded.
