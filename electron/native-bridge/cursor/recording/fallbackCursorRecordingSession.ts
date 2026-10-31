import type { Rectangle } from "electron";
import type { CursorRecordingData } from "../../../../src/native/contracts";
import type { CursorRecordingSession } from "./session";

interface FallbackCursorRecordingSessionOptions {
	primary: CursorRecordingSession;
	createFallback: () => CursorRecordingSession;
	/** Label used in the warning when the primary session cannot start. */
	fallbackLabel?: string;
}

/**
 * Tries a native cursor session first and, if `start()` rejects, starts a
 * fallback instead. Used on Linux X11 so a ScreenCast portal without METADATA
 * cursor mode still produces a `.cursor.json` sidecar.
 *
 * `stop()` and `updateCaptureBounds()` always talk to whichever session actually
 * started. A fallback that also fails is surfaced to the caller — there is then
 * honestly no pointer data.
 */
export class FallbackCursorRecordingSession implements CursorRecordingSession {
	private active: CursorRecordingSession | null = null;
	private readonly fallbackLabel: string;

	constructor(private readonly options: FallbackCursorRecordingSessionOptions) {
		this.fallbackLabel = options.fallbackLabel ?? "X11 pointer sampler";
	}

	async start(): Promise<void> {
		try {
			await this.options.primary.start();
			this.active = this.options.primary;
		} catch (error) {
			console.warn(
				`[cursor] native cursor capture unavailable; using ${this.fallbackLabel} instead:`,
				error,
			);
			const fallback = this.options.createFallback();
			await fallback.start();
			this.active = fallback;
		}
	}

	async stop(): Promise<CursorRecordingData> {
		const session = this.active;
		this.active = null;
		if (!session) {
			return { version: 2, provider: "none", samples: [], assets: [] };
		}
		return session.stop();
	}

	updateCaptureBounds(bounds: Rectangle): void {
		this.active?.updateCaptureBounds?.(bounds);
	}
}
