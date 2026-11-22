// The keyboard-only capture that drives the keystroke overlay must survive a
// Start/Stop race: a Stop issued while `start()` is still pending has to tear
// the helper down, a second Start must not slip past the empty slot, and keys
// queued by a torn-down helper must never reach the overlay. These invariants
// live in handlers.ts, whose registration needs the whole Electron runtime, so
// we assert them against the source the way recordingStateRouting.test.ts does.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(
	path.join(path.dirname(fileURLToPath(import.meta.url)), "handlers.ts"),
	"utf8",
);

function fnBody(name: string): string {
	const start = source.indexOf(`async function ${name}(`);
	expect(start, `no ${name}`).toBeGreaterThan(-1);
	const end = source.indexOf("\n}\n", start);
	return source.slice(start, end === -1 ? undefined : end);
}

describe("keystroke key capture lifecycle", () => {
	const start = fnBody("startKeystrokeKeyCapture");
	const stop = fnBody("stopKeystrokeKeyCapture");

	it("tracks a pending session before awaiting start()", () => {
		expect(start).toContain("pendingKeystrokeKeySession = session");
		expect(start.indexOf("pendingKeystrokeKeySession = session")).toBeLessThan(
			start.indexOf("await session.start()"),
		);
	});

	it("refuses a second start while a session is pending or live", () => {
		const guard = start.slice(0, start.indexOf("const generation"));
		expect(guard).toContain("pendingKeystrokeKeySession");
		expect(guard).toContain("keystrokeKeySession");
		expect(guard).toContain("return");
	});

	it("invalidates an in-flight start on Stop and tears down either slot", () => {
		expect(stop).toContain("keystrokeKeyGeneration += 1");
		expect(stop).toContain("keystrokeKeySession ?? pendingKeystrokeKeySession");
		expect(stop.indexOf("keystrokeKeyGeneration += 1")).toBeLessThan(
			stop.indexOf("keystrokeKeySession = null"),
		);
		expect(stop).toContain("session.stop()");
	});

	it("does not republish a session whose generation Stop invalidated", () => {
		expect(start).toContain("if (generation !== keystrokeKeyGeneration) return;");
		expect(start).toContain("keystrokeKeySession = session");
	});

	it("drops key events from a torn-down session", () => {
		expect(start).toContain("if (generation !== keystrokeKeyGeneration) return;");
		expect(start).toContain("broadcastKeystroke(event.vk, event.modifiers)");
	});

	it("owns teardown once: a stale start does not stop the session Stop already stopped", () => {
		// The generation-mismatch branch must only `return`, never call stop().
		const mismatch = start.slice(start.indexOf("if (generation !== keystrokeKeyGeneration)"));
		const branch = mismatch.slice(0, mismatch.indexOf("keystrokeKeySession = session"));
		expect(branch).not.toContain("session.stop()");
	});
});
