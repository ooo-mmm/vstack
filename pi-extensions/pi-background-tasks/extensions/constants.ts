export const BG_COMMAND = "bg";
export const DEFAULT_BACKGROUND_BASH_SHORTCUT = "alt+.";
export const DEFAULT_BG_SHORTCUT = "alt+shift+h";
export const DEFAULT_WIDGET_TOGGLE_SHORTCUT = "alt+h";
export const CONFIG_ID = "@vanillagreen/pi-background-tasks";
export const BG_MESSAGE_TYPE = "vstack-background-tasks:event";
export const BG_WIDGET_KEY = "vstack-background-tasks";
export const BG_INSTALL_SYMBOL = Symbol.for("vstack.background-tasks.installed");
export const VSTACK_MODAL_LOCK_SYMBOL = Symbol.for("vstack.pi.modal-lock");

// Nerd Font glyphs (Font Awesome subset). Status icons use these instead of
// unicode dingbats so chat output renders consistently regardless of any
// emoji-presentation fallback in the user's font stack.
export const ICONS = {
	check: "\uf00c", // nf-fa-check
	times: "\uf00d", // nf-fa-times
} as const;

export const DEFAULT_TIMEOUT_MS = 0;
export const DEFAULT_OUTPUT_SETTLE_MS = 1_500;
export const DEFAULT_FORCE_KILL_GRACE_MS = 5_000;
export const DEFAULT_OUTPUT_BUFFER_MAX_CHARS = 1_000_000;
export const DEFAULT_OUTPUT_ALERT_MAX_CHARS = 10_000;
export const DEFAULT_LOG_TAIL_MAX_CHARS = 50_000;
export const DEFAULT_FORCED_BACKGROUND_WINDOW_MS = 5 * 60 * 1_000;
export const DEFAULT_WIDGET_FINISHED_RETENTION_MS = 15_000;

export const DASHBOARD_WIDTH = 96;
export const DASHBOARD_MAX_HEIGHT = "75%";
export const DASHBOARD_PADDING_X = 2;
export const DASHBOARD_PADDING_Y = 1;
export const DASHBOARD_MIN_FRAME_ROWS = 14;
export const DASHBOARD_FRAME_VERTICAL_OVERHEAD = 2 + DASHBOARD_PADDING_Y * 2;
export const TASK_PANE_MIN_WIDTH = 30;
export const TASK_PANE_MAX_WIDTH = 42;
export const WIDGET_PADDING_X = 1;
export const TOOL_PREVIEW_TASKS = 3;
export const TOOL_PREVIEW_LINES = 12;
export const WIDGET_COMPACT_TASKS = 3;

const ANSI_GREEN_FG = "\x1b[32m";
const ANSI_YELLOW_FG = "\x1b[33m";
const ANSI_FG_RESET = "\x1b[39m";

export function ansiGreen(text: string): string {
	return `${ANSI_GREEN_FG}${text}${ANSI_FG_RESET}`;
}

export function ansiYellow(text: string): string {
	return `${ANSI_YELLOW_FG}${text}${ANSI_FG_RESET}`;
}

export function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}
