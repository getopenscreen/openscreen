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

/** The continuation after `start()` settles — where a stale start must not publish. */
function afterStart(body: string): string {
	const anchor = body.indexOf("await session.start()");
	expect(anchor, "no await session.start()").toBeGreaterThan(-1);
	return body.slice(anchor);
}

/** The `onKeyEvent` callback — where queued keys from a stale session must be dropped. */
function keyEventCallback(body: string): string {
	const anchor = body.indexOf("onKeyEvent:");
	expect(anchor, "no onKeyEvent").toBeGreaterThan(-1);
	// The callback closes with `},` (an object property), not `}),`. Bound the
	// slice at the first statement after the factory call so the post-start
	// continuation guard cannot leak into this region.
	const end = body.indexOf("pendingKeystrokeKeySession = session", anchor);
	expect(end, "no statement after onKeyEvent").toBeGreaterThan(-1);
	return body.slice(anchor, end);
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
		// Scope to the continuation after start(): a guard only inside onKeyEvent
		// must not satisfy this test.
		const continuation = afterStart(start);
		expect(continuation).toContain("if (generation !== keystrokeKeyGeneration) return;");
		expect(continuation).toContain("keystrokeKeySession = session");
	});

	it("drops key events from a torn-down session", () => {
		// Scope to the callback only: a guard only in the post-start continuation
		// must not satisfy this test.
		const callback = keyEventCallback(start);
		expect(callback).toContain("if (generation !== keystrokeKeyGeneration) return;");
		expect(callback).toContain("broadcastKeystroke(event.vk, event.modifiers)");
	});

	it("owns teardown once: a stale start does not stop the session Stop already stopped", () => {
		// The generation-mismatch branch in the post-start continuation must only
		// `return`, never call stop() — Stop is the sole owner of teardown.
		const continuation = afterStart(start);
		const mismatch = continuation.indexOf("if (generation !== keystrokeKeyGeneration)");
		expect(mismatch, "no completion generation guard").toBeGreaterThan(-1);
		const branch = continuation.slice(
			mismatch,
			continuation.indexOf("keystrokeKeySession = session"),
		);
		expect(branch).not.toContain("session.stop()");
	});
});
