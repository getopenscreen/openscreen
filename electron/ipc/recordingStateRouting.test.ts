// Every start and stop of a take reaches the MCP recorder.
//
// The native capture paths start and stop in the main process and used to call
// `onRecordingStateChange` themselves, so only the browser path's `set-recording-state`
// told the in-app MCP recorder a take had started. On Windows native capture, an MCP
// `startRecording` then waited out its 120 s on a take already running.
//
// The fix routes every path through `setAppRecording` in handlers.ts. The scan below is
// syntactic, like macSpaces.test.ts: registerIpcHandlers needs all of Electron to run.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(
	path.join(path.dirname(fileURLToPath(import.meta.url)), "handlers.ts"),
	"utf8",
);

/** The text of the `ipcMain.handle` registered for `channel`, up to the next one. */
function handlerBody(channel: string): string {
	const start = source.indexOf(`"${channel}"`);
	expect(start, `no handler for ${channel}`).toBeGreaterThan(-1);
	const end = source.indexOf("ipcMain.handle(", start);
	return source.slice(start, end === -1 ? undefined : end);
}

const count = (pattern: RegExp) => source.match(pattern)?.length ?? 0;

describe("recording state routing", () => {
	it("changes the recording state in setAppRecording only", () => {
		expect(count(/onRecordingStateChange(\?\.)?\(/g)).toBe(1);
		expect(count(/mcpAppRecorder\.recordingChanged\(/g)).toBe(1);
		expect(count(/(?<!let )\bappRecording = /g)).toBe(1);
		const setter = source.slice(source.indexOf("const setAppRecording"));
		const body = setter.slice(0, setter.indexOf("};"));
		expect(body).toContain("appRecording = recording");
		expect(body).toContain("mcpAppRecorder.recordingChanged(recording)");
		expect(body).toContain("onRecordingStateChange?.(recording, sourceName)");
	});

	it.each(["windows", "mac", "linux"])("a native %s start and stop notify it", (platform) => {
		expect(handlerBody(`start-native-${platform}-recording`)).toContain("setAppRecording(true");
		expect(handlerBody(`stop-native-${platform}-recording`)).toContain("setAppRecording(false");
	});

	it("the browser path notifies it", () => {
		expect(handlerBody("set-recording-state")).toContain("setAppRecording(recording");
	});
});
