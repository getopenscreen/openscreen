import fs from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = fs.readFileSync(new URL("./handlers.ts", import.meta.url), "utf8");

// Execute the small registration in isolation: importing handlers.ts requires
// the complete Electron runtime, but a source-only assertion misses broken cleanup.
function fixture() {
	const start = source.indexOf('ipcMain.handle("discard-cursor-telemetry"');
	expect(start).toBeGreaterThan(-1);
	const end = source.indexOf("\n\t});", start) + 7;
	const handle = vi.fn();
	const context = {
		ipcMain: { handle },
		cursorTelemetryRecordingId: 7 as number | null,
		pendingCursorRecordingData: { samples: [1] } as unknown,
		stopCursorRecording: vi.fn(async () => undefined),
	};
	runInNewContext(source.slice(start, end).replace("recordingId: number", "recordingId"), context);
	return {
		context,
		discard: handle.mock.calls[0][1] as (event: unknown, id: number) => Promise<void>,
	};
}

describe("discard cursor telemetry IPC", () => {
	it("registers the preload channel and clears only the matching take after stopping", async () => {
		const { context, discard } = fixture();
		await discard({}, 7);
		expect(context.stopCursorRecording).toHaveBeenCalledTimes(1);
		expect(context.pendingCursorRecordingData).toBeNull();
		expect(context.cursorTelemetryRecordingId).toBeNull();
	});
	it("does not clear a newer take if stopping the old sampler yields", async () => {
		const { context, discard } = fixture();
		context.stopCursorRecording.mockImplementation(async () => {
			context.cursorTelemetryRecordingId = 8;
			context.pendingCursorRecordingData = { samples: [2] };
		});
		await discard({}, 7);
		expect(context.cursorTelemetryRecordingId).toBe(8);
		expect(context.pendingCursorRecordingData).toEqual({ samples: [2] });
	});

	it.each([6, NaN, Infinity])("ignores stale or invalid discard id %s", async (id) => {
		const { context, discard } = fixture();
		await discard({}, id);
		expect(context.stopCursorRecording).not.toHaveBeenCalled();
		expect(context.pendingCursorRecordingData).not.toBeNull();
		expect(context.cursorTelemetryRecordingId).toBe(7);
	});
	it("compacts and bounds the browser track before publishing its sidecar", () => {
		const body = source.slice(source.indexOf("async function storeRecordedSessionFiles"));
		expect(body.indexOf("finalizeBrowserCursorTelemetry(")).toBeLessThan(
			body.indexOf("await writePendingCursorTelemetry(screenVideoPath)"),
		);
		expect(body).toContain("payload.cursorPauseRanges");
		expect(body).toContain("payload.durationMs");
	});
});
