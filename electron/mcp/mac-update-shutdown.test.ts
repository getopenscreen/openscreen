import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestMacMcpShutdown, watchForMacMcpShutdown } from "./mac-update-shutdown";

let directory: string;
const disposers: Array<() => void> = [];

beforeEach(() => {
	directory = mkdtempSync(path.join(os.tmpdir(), "mcp-update-shutdown-"));
	vi.useFakeTimers();
});

afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
	vi.useRealTimers();
	rmSync(directory, { recursive: true, force: true });
});

function identity(
	version = "2.3.0-rc.5",
	executablePath = "/Applications/Openscreen.app/Contents/MacOS/Openscreen",
) {
	return { executablePath, version, markerDirectory: directory };
}

describe("macOS MCP shutdown for a user-requested update", () => {
	it("waits for active work to finish even after the new-session signal expires", () => {
		const close = vi.fn(() => false as boolean);
		disposers.push(watchForMacMcpShutdown(identity(), close));
		requestMacMcpShutdown(identity());
		vi.advanceTimersByTime(500);
		expect(close).toHaveBeenCalledOnce();
		vi.advanceTimersByTime(120_000);
		expect(close.mock.calls.length).toBeGreaterThan(1);
		close.mockReturnValue(true);
		vi.advanceTimersByTime(500);
		const calls = close.mock.calls.length;
		vi.advanceTimersByTime(1000);
		expect(close).toHaveBeenCalledTimes(calls);
	});
	it("closes all matching sessions once, including sessions on different profiles", () => {
		const first = vi.fn();
		const second = vi.fn();
		disposers.push(watchForMacMcpShutdown(identity(), first));
		disposers.push(watchForMacMcpShutdown(identity(), second));
		vi.advanceTimersByTime(1000);
		expect(first).not.toHaveBeenCalled();
		requestMacMcpShutdown(identity());
		vi.advanceTimersByTime(1000);
		expect(first).toHaveBeenCalledOnce();
		expect(second).toHaveBeenCalledOnce();
	});

	it("also closes a matching session started while installation is in progress", () => {
		requestMacMcpShutdown(identity());
		const close = vi.fn();
		disposers.push(watchForMacMcpShutdown(identity(), close));
		expect(close).toHaveBeenCalledOnce();
	});

	it("leaves a new version and a different app copy running", () => {
		requestMacMcpShutdown(identity());
		const close = vi.fn();
		disposers.push(watchForMacMcpShutdown(identity("2.3.0-rc.6"), close));
		disposers.push(watchForMacMcpShutdown(identity(undefined, "/Other/Openscreen"), close));
		vi.advanceTimersByTime(1000);
		expect(close).not.toHaveBeenCalled();
	});

	it("ignores expired requests and clock rollbacks", () => {
		requestMacMcpShutdown(identity());
		vi.advanceTimersByTime(120_001);
		const close = vi.fn();
		disposers.push(watchForMacMcpShutdown(identity(), close));
		expect(close).not.toHaveBeenCalled();
		requestMacMcpShutdown(identity());
		vi.setSystemTime(Date.now() - 60_000);
		vi.advanceTimersByTime(500);
		expect(close).not.toHaveBeenCalled();
	});

	it("ignores a partially written request and retries it", () => {
		requestMacMcpShutdown(identity());
		const file = path.join(directory, readdirSync(directory)[0]);
		writeFileSync(file, "{");
		const close = vi.fn();
		disposers.push(watchForMacMcpShutdown(identity(), close));
		expect(close).not.toHaveBeenCalled();
		requestMacMcpShutdown(identity());
		vi.advanceTimersByTime(500);
		expect(close).toHaveBeenCalledOnce();
	});

	it("stops watching when disposed", () => {
		const close = vi.fn();
		watchForMacMcpShutdown(identity(), close)();
		requestMacMcpShutdown(identity());
		vi.advanceTimersByTime(500);
		expect(close).not.toHaveBeenCalled();
	});
});
