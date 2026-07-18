export interface WindowsCursorSamplerBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

export function buildWindowsCursorSamplerArgs(
	sampleIntervalMs: number,
	windowHandle: string | null,
	physicalDisplayBounds: WindowsCursorSamplerBounds,
): string[] {
	return [
		String(sampleIntervalMs),
		windowHandle ?? "null",
		String(physicalDisplayBounds.x),
		String(physicalDisplayBounds.y),
		String(physicalDisplayBounds.width),
		String(physicalDisplayBounds.height),
	];
}
