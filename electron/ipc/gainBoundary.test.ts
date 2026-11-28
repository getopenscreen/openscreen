// Direct IPC/MCP callers can pass a negative linear audio gain. macOS clamps it
// but the Linux and Windows helpers do not — a negative scalar flips the phase
// of the captured audio. Every gain that reaches a helper must pass through the
// boundary clamp. handlers.ts needs the whole Electron runtime to import, so
// the invariant is asserted against its source like recordingStateRouting.test.ts.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(
	path.join(path.dirname(fileURLToPath(import.meta.url)), "handlers.ts"),
	"utf8",
);

describe("helper audio gain boundary", () => {
	it("clamps negative gains and treats non-finite values as the fallback", () => {
		const start = source.indexOf("function safeGainScalar(");
		expect(start).toBeGreaterThan(-1);
		const body = source.slice(start, source.indexOf("\n}", start));
		expect(body).toContain("Number.isFinite");
		expect(body).toContain("Math.max(0, gain)");
	});

	it("does not pass a raw request gain through to any helper", () => {
		// Every gain assignment in a helper config goes through the clamp. A raw
		// `request.audio.<source>.gain` on the right-hand side would bypass it.
		expect(source).not.toMatch(/(systemGain|microphoneGain|gain): request\.audio\./);
	});

	it("keeps the helper config keys for system and microphone gain", () => {
		expect(source).toContain("systemGain: safeGainScalar(");
		expect(source).toContain("microphoneGain: safeGainScalar(");
	});
});
