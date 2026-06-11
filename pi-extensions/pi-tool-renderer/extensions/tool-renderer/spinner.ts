/**
 * Global spinner state shared across all tool renderers.
 */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

let _frame = 0;
let _timer: ReturnType<typeof setInterval> | undefined;
let _listeners: Array<() => void> = [];

function tick(): void {
	_frame = (_frame + 1) % SPINNER_FRAMES.length;
	for (const fn of _listeners) fn();
}

export function startSpinner(): void {
	if (_timer) return;
	_timer = setInterval(tick, 100);
}

export function stopSpinner(): void {
	if (_timer) { clearInterval(_timer); _timer = undefined; }
	_frame = 0;
}

export function spinnerFrame(): number {
	return _frame;
}

export function onSpinnerTick(fn: () => void): () => void {
	_listeners.push(fn);
	return () => { _listeners = _listeners.filter(l => l !== fn); };
}
