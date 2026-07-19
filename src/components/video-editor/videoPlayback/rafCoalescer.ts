/**
 * Coalesces rapid-fire calls into at most one flush per animation frame.
 *
 * Used so a ref-backed value can be updated synchronously on every call (cheap),
 * while an expensive side effect — e.g. a React state commit — is deferred to
 * once per frame. Without this, a burst of calls within the same frame (many
 * `seeking` events fired while dragging the timeline playhead) would otherwise
 * force one state commit per call, saturating the main thread and making both
 * the drag and the playhead's own rendering feel laggy.
 */
export function createRafCoalescer<T>(flush: (value: T) => void) {
	let pendingValue: T | undefined;
	let hasPending = false;
	let rafId: number | null = null;

	const schedule = (value: T) => {
		pendingValue = value;
		hasPending = true;
		if (rafId !== null) return;
		rafId = requestAnimationFrame(() => {
			rafId = null;
			if (hasPending) {
				hasPending = false;
				const valueToFlush = pendingValue as T;
				pendingValue = undefined;
				flush(valueToFlush);
			}
		});
	};

	const cancel = () => {
		if (rafId !== null) {
			cancelAnimationFrame(rafId);
			rafId = null;
		}
		hasPending = false;
		pendingValue = undefined;
	};

	return { schedule, cancel };
}
