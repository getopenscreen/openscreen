/** A deadline cannot distinguish a stalled capturer from an unanswered portal picker. */
export function desktopSourceTimeoutMessage(timeoutMs: number): string {
	return (
		`Desktop source enumeration did not return within ${timeoutMs}ms. ` +
		"A system screen-sharing picker may still be waiting for a choice. " +
		"Cancel any open picker and retry, selecting a source before the timeout. " +
		"If no picker opens, check that a display server is available and graphics initialization succeeded."
	);
}
