import { spawn } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	countToolCall,
	installWeekFrom,
	loadUsagePingState,
	periodKeys,
	planUsagePing,
	sendUsagePing,
	setUsagePingEnabled,
	type UsagePingFacts,
	type UsagePingState,
	withStateLock,
} from "./usage-ping";

const temps: string[] = [];

afterEach(() => {
	for (const dir of temps) rmSync(dir, { recursive: true, force: true });
	temps.length = 0;
});

function tmp(): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), "usage-ping-"));
	temps.push(dir);
	return dir;
}

const fresh: UsagePingState = {
	enabled: true,
	day: null,
	week: null,
	month: null,
	installWeek: null,
	tools: {},
	generation: 0,
	sending: null,
};
const facts: UsagePingFacts = {
	version: "2.0.0",
	os: "win32",
	arch: "x64",
	channel: "store",
	surface: "app",
};
// Wednesday 14 October 2026.
const wednesday = new Date("2026-10-14T09:00:00Z");

describe("periodKeys", () => {
	it("uses UTC and ISO weeks, which belong to the year of their Thursday", () => {
		expect(periodKeys(wednesday)).toEqual({
			day: "2026-10-14",
			week: "2026-W42",
			month: "2026-10",
		});
		expect(periodKeys(new Date("2027-01-01T12:00:00Z")).week).toBe("2026-W53");
		expect(periodKeys(new Date("2026-01-01T12:00:00Z")).week).toBe("2026-W01");
	});
});

describe("planUsagePing", () => {
	it("stays silent when turned off, in dev, under DO_NOT_TRACK or CI, and twice a day", () => {
		expect(planUsagePing({ ...fresh, enabled: false }, "store", {}, wednesday)).toBeNull();
		expect(planUsagePing(fresh, "dev", {}, wednesday)).toBeNull();
		expect(planUsagePing(fresh, "store", { DO_NOT_TRACK: "1" }, wednesday)).toBeNull();
		expect(planUsagePing(fresh, "store", { CI: "true" }, wednesday)).toBeNull();
		const today = { ...fresh, ...periodKeys(wednesday) };
		expect(planUsagePing(today, "store", {}, wednesday)).toBeNull();
		expect(planUsagePing(fresh, "store", { DO_NOT_TRACK: "0" }, wednesday)).not.toBeNull();
		expect(planUsagePing(fresh, "store", { CI: "false" }, wednesday)).not.toBeNull();
	});

	it("flags the first ping of each week and month, so actives count without an ID", () => {
		expect(planUsagePing(fresh, "nsis", {}, wednesday)).toMatchObject({
			firstThisWeek: true,
			firstThisMonth: true,
		});
		const tuesday = { ...fresh, ...periodKeys(new Date("2026-10-13T09:00:00Z")) };
		expect(planUsagePing(tuesday, "nsis", {}, wednesday)).toMatchObject({
			firstThisWeek: false,
			firstThisMonth: false,
		});
		const lastSunday = { ...fresh, ...periodKeys(new Date("2026-10-11T09:00:00Z")) };
		expect(planUsagePing(lastSunday, "nsis", {}, wednesday)).toMatchObject({
			firstThisWeek: true,
			firstThisMonth: false,
		});
	});
});

describe("sendUsagePing", () => {
	it("sends no identifier and keeps the dates only once PostHog accepted the ping", async () => {
		const dir = tmp();
		const bodies: Record<string, unknown>[] = [];
		const ok = async (_url: string, init: RequestInit) => {
			bodies.push(JSON.parse(String(init.body)));
			return { ok: true };
		};

		await sendUsagePing(dir, facts, {}, wednesday, async () => ({ ok: false }));
		expect(loadUsagePingState(dir).day).toBeNull();

		await sendUsagePing(dir, facts, {}, wednesday, ok);
		await sendUsagePing(dir, facts, {}, wednesday, ok);
		await sendUsagePing(dir, facts, {}, new Date("2026-10-15T09:00:00Z"), ok);
		expect(bodies).toHaveLength(2);
		expect(bodies[0].distinct_id).not.toBe(bodies[1].distinct_id);
		const { install_week, ...rest } = bodies[0].properties as Record<string, unknown>;
		expect(install_week).toMatch(/^\d{4}-W\d{2}$/);
		expect(rest).toEqual({
			$process_person_profile: false,
			$geoip_disable: true,
			version: "2.0.0",
			os: "win32",
			arch: "x64",
			channel: "store",
			surface: "app",
			first_this_week: true,
			first_this_month: true,
		});
		// Nothing ID-like rides along: no UUID, no hash, no long opaque token.
		for (const body of bodies)
			for (const value of Object.values(body.properties as Record<string, unknown>))
				expect(String(value)).not.toMatch(
					/[0-9a-f]{8}-[0-9a-f]{4}|[0-9a-f]{16,}|[A-Za-z0-9+/=]{24,}/i,
				);
	});

	it("keeps the checkbox off when it is unticked while a ping is in flight", async () => {
		const dir = tmp();
		await sendUsagePing(dir, facts, {}, wednesday, async () => {
			setUsagePingEnabled(dir, false);
			return { ok: true };
		});
		expect(loadUsagePingState(dir)).toMatchObject({ enabled: false, day: "2026-10-14" });
	});
});

describe("the opt-out", () => {
	it("holds when another process saves a state it read before the user unticked the box", async () => {
		const dir = tmp();
		const file = path.join(dir, "usage-ping.json");
		countToolCall(dir, "store", "getFrames", {});
		// What `openscreen mcp` read just before the tray's opt-out...
		const stale = readFileSync(file, "utf8");
		setUsagePingEnabled(dir, false);
		// ...and wrote back just after it, with `enabled: true` and a count in it.
		writeFileSync(file, stale);
		expect(JSON.parse(readFileSync(file, "utf8")).enabled).toBe(true);
		expect(loadUsagePingState(dir).enabled).toBe(false);
		countToolCall(dir, "store", "getFrames", {});
		let sent = 0;
		await sendUsagePing(dir, facts, {}, wednesday, async () => {
			sent++;
			return { ok: true };
		});
		expect(sent).toBe(0);
		// Ticked again, it starts from nothing: the stale count is never sent.
		setUsagePingEnabled(dir, true);
		expect(loadUsagePingState(dir)).toMatchObject({ enabled: true, tools: {} });
	});

	it("holds when the stale state is saved after the box was unticked and ticked again", () => {
		const dir = tmp();
		const file = path.join(dir, "usage-ping.json");
		countToolCall(dir, "store", "getFrames", {});
		const stale = readFileSync(file, "utf8");
		setUsagePingEnabled(dir, false);
		setUsagePingEnabled(dir, true);
		// The other process writes back what it read, one call more, once the box is ticked again.
		const counted = { ...JSON.parse(stale), tools: { getFrames: 2 } };
		writeFileSync(file, JSON.stringify(counted));
		// Counted before the user's last choice: dropped, and counting starts again from there.
		expect(loadUsagePingState(dir).tools).toEqual({});
		countToolCall(dir, "store", "addZoom", {});
		expect(loadUsagePingState(dir).tools).toEqual({ addZoom: 1 });
	});
});

describe("the state lock", () => {
	it("makes a count wait for another process's change, then land on top of it", async () => {
		const dir = tmp();
		countToolCall(dir, "store", "getFrames", {});
		// Another process takes the lock, reads the state, holds it 300 ms, then writes back one
		// call more of its own, as a count in `openscreen mcp` does.
		const script = path.join(dir, "writer.cjs");
		writeFileSync(
			script,
			`const fs = require("node:fs");
const path = require("node:path");
const dir = process.argv[2];
const lock = path.join(dir, "usage-ping.lock");
const file = path.join(dir, "usage-ping.json");
fs.writeFileSync(lock, "", { flag: "wx" });
const state = JSON.parse(fs.readFileSync(file, "utf8"));
process.stdout.write("locked\\n");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
state.tools.getFrames += 1;
fs.writeFileSync(file, JSON.stringify(state));
fs.rmSync(lock);
`,
		);
		const writer = spawn(process.execPath, [script, dir]);
		const exited = new Promise((resolve) => writer.on("exit", resolve));
		await new Promise((resolve) => writer.stdout.once("data", resolve));
		// Counted while the other process holds the lock. Without it, that process's write would
		// land after this one and take this call away.
		countToolCall(dir, "store", "addZoom", {});
		await exited;
		expect(loadUsagePingState(dir).tools).toEqual({ getFrames: 2, addZoom: 1 });
		expect(existsSync(path.join(dir, "usage-ping.lock"))).toBe(false);
	});

	it("drops a change that waited a second, rather than write over a newer one", () => {
		const dir = tmp();
		const lock = path.join(dir, "usage-ping.lock");
		// Another process holds the lock for longer than the wait; dated ahead, so the test's
		// own wait never makes it look abandoned.
		writeFileSync(lock, "another process");
		const ahead = new Date(Date.now() + 60_000);
		utimesSync(lock, ahead, ahead);
		countToolCall(dir, "store", "getFrames", {});
		expect(loadUsagePingState(dir).tools).toEqual({});
		expect(readFileSync(lock, "utf8")).toBe("another process");
		// The opt-out does not wait on it: its own file says it at once.
		setUsagePingEnabled(dir, false);
		expect(loadUsagePingState(dir).enabled).toBe(false);
	});

	it("drops the write of a change whose lock was taken meanwhile as abandoned", () => {
		const dir = tmp();
		const lock = path.join(dir, "usage-ping.lock");
		countToolCall(dir, "store", "getFrames", {});
		withStateLock(dir, (save) => {
			// This change stalls; another process takes the lock as abandoned and counts.
			writeFileSync(lock, "another process");
			expect(save({ ...loadUsagePingState(dir), tools: {} })).toBe(false);
		});
		expect(loadUsagePingState(dir).tools).toEqual({ getFrames: 1 });
		// The lock is the other process's now: it is left in place.
		expect(readFileSync(lock, "utf8")).toBe("another process");
	});

	it("breaks a lock left by a process that died holding it", () => {
		const dir = tmp();
		const lock = path.join(dir, "usage-ping.lock");
		writeFileSync(lock, "");
		const old = new Date(Date.now() - 5_000);
		utimesSync(lock, old, old);
		countToolCall(dir, "store", "getFrames", {});
		expect(loadUsagePingState(dir).tools).toEqual({ getFrames: 1 });
		expect(existsSync(lock)).toBe(false);
	});
});

describe("tool call counts", () => {
	const sentBy = async (dir: string, now: Date, during?: () => void) => {
		let properties: Record<string, unknown> | null = null;
		await sendUsagePing(dir, { ...facts, surface: "mcp" }, {}, now, async (_url, init) => {
			properties = JSON.parse(String(init.body)).properties;
			during?.();
			return { ok: true };
		});
		return properties as Record<string, unknown> | null;
	};

	it("ride the next ping as a name and a number, then are forgotten", async () => {
		const dir = tmp();
		// Today's ping left before any tool was called: it carries no count at all.
		expect(await sentBy(dir, wednesday)).not.toHaveProperty("mcp_tools");
		countToolCall(dir, "store", "getFrames", {});
		countToolCall(dir, "store", "getFrames", {});
		countToolCall(dir, "store", "addZoom", {});
		expect(loadUsagePingState(dir).tools).toEqual({ getFrames: 2, addZoom: 1 });
		// Still today: no second ping, the counts wait.
		expect(await sentBy(dir, wednesday)).toBeNull();

		const thursday = new Date("2026-10-15T09:00:00Z");
		const sent = await sentBy(dir, thursday);
		expect(sent?.mcp_tools).toEqual({ getFrames: 2, addZoom: 1 });
		expect(loadUsagePingState(dir).tools).toEqual({});
	});

	it("keep a call made while the ping was in flight, and wait when the ping fails", async () => {
		const dir = tmp();
		countToolCall(dir, "store", "getFrames", {});
		await sendUsagePing(dir, facts, {}, wednesday, async () => ({ ok: false }));
		expect(loadUsagePingState(dir).tools).toEqual({ getFrames: 1 });

		const sent = await sentBy(dir, wednesday, () => {
			countToolCall(dir, "store", "getFrames", {});
			countToolCall(dir, "store", "exportVideo", {});
		});
		expect(sent?.mcp_tools).toEqual({ getFrames: 1 });
		expect(loadUsagePingState(dir).tools).toEqual({ getFrames: 1, exportVideo: 1 });
	});

	it("keep a call made after the box was unticked and ticked again while the ping was in flight", async () => {
		const dir = tmp();
		countToolCall(dir, "store", "getFrames", {});
		const sent = await sentBy(dir, wednesday, () => {
			setUsagePingEnabled(dir, false);
			setUsagePingEnabled(dir, true);
			countToolCall(dir, "store", "getFrames", {});
		});
		expect(sent?.mcp_tools).toEqual({ getFrames: 1 });
		// The ping carried the call made before the change, not this one: it waits for the next.
		expect(loadUsagePingState(dir).tools).toEqual({ getFrames: 1 });
	});

	it("ride one ping only when two overlap, which counts the day once", async () => {
		const dir = tmp();
		countToolCall(dir, "store", "getFrames", {});
		const sent: Array<Record<string, unknown>> = [];
		let answer: (ok: boolean) => void = () => undefined;
		const first = sendUsagePing(dir, facts, {}, wednesday, (_url, init) => {
			sent.push(JSON.parse(String(init.body)).properties);
			return new Promise((resolve) => {
				answer = (ok) => resolve({ ok });
			});
		});
		// Another process pings while the first is on its way: it leaves the day to it.
		await sendUsagePing(dir, { ...facts, surface: "mcp" }, {}, wednesday, async (_url, init) => {
			sent.push(JSON.parse(String(init.body)).properties);
			return { ok: true };
		});
		countToolCall(dir, "store", "addZoom", {});
		answer(true);
		await first;
		expect(sent).toHaveLength(1);
		expect(sent[0].mcp_tools).toEqual({ getFrames: 1 });
		expect(loadUsagePingState(dir)).toMatchObject({
			day: "2026-10-14",
			tools: { addZoom: 1 },
			sending: null,
		});
	});

	it("go back when PostHog refuses them, beside the calls made meanwhile", async () => {
		const dir = tmp();
		countToolCall(dir, "store", "getFrames", {});
		await sendUsagePing(dir, facts, {}, wednesday, async () => {
			countToolCall(dir, "store", "getFrames", {});
			countToolCall(dir, "store", "addZoom", {});
			return { ok: false };
		});
		expect(loadUsagePingState(dir)).toMatchObject({
			day: null,
			tools: { getFrames: 2, addZoom: 1 },
			sending: null,
		});
	});

	it("go out with the next ping when the process that claimed them died", async () => {
		const dir = tmp();
		const abandoned = { id: "gone", at: Date.now() - 10 * 60_000, tools: { getFrames: 3 } };
		writeFileSync(
			path.join(dir, "usage-ping.json"),
			JSON.stringify({ ...fresh, tools: { addZoom: 1 }, sending: abandoned }),
		);
		expect((await sentBy(dir, wednesday))?.mcp_tools).toEqual({ getFrames: 3, addZoom: 1 });
		expect(loadUsagePingState(dir)).toMatchObject({ tools: {}, sending: null });
	});

	it("count nothing when turned off, in dev, under DO_NOT_TRACK or CI", () => {
		const dir = tmp();
		countToolCall(dir, "dev", "getFrames", {});
		countToolCall(dir, "store", "getFrames", { DO_NOT_TRACK: "1" });
		countToolCall(dir, "store", "getFrames", { CI: "true" });
		expect(loadUsagePingState(dir).tools).toEqual({});

		countToolCall(dir, "store", "getFrames", {});
		// Unticking the tray's checkbox drops what was counted, and stops the counting.
		setUsagePingEnabled(dir, false);
		countToolCall(dir, "store", "getFrames", {});
		expect(loadUsagePingState(dir).tools).toEqual({});
		setUsagePingEnabled(dir, true);
		expect(loadUsagePingState(dir).tools).toEqual({});
	});

	it("take a tool's name only, and read back nothing else from an edited file", () => {
		const dir = tmp();
		// Not names a server registers: a path, a sentence, an empty string.
		for (const name of ["C:\\Users\\me\\take.mp4", "my secret project", "", "a".repeat(65)]) {
			countToolCall(dir, "store", name, {});
		}
		expect(loadUsagePingState(dir).tools).toEqual({});

		const tools = { getFrames: 3, "../etc": 4, addZoom: -1, exportVideo: 1.5, listSources: "9" };
		writeFileSync(path.join(dir, "usage-ping.json"), JSON.stringify({ ...fresh, tools }));
		expect(loadUsagePingState(dir).tools).toEqual({ getFrames: 3 });
		writeFileSync(path.join(dir, "usage-ping.json"), JSON.stringify({ ...fresh, tools: "x" }));
		expect(loadUsagePingState(dir).tools).toEqual({});
	});
});

describe("install week", () => {
	it("dates the install by the userData directory's birthtime, never its mtime", () => {
		expect(installWeekFrom({ birthtimeMs: Date.parse("2025-05-07T12:00:00Z") })).toBe("2025-W19");
		// Filesystems that record no birthtime report 0; mtime would move, so no fallback.
		const mtimeMs = Date.parse("2025-05-07T12:00:00Z");
		for (const birthtimeMs of [0, Number.NaN]) {
			const stats = { birthtimeMs, mtimeMs };
			expect(installWeekFrom(stats)).toBe("unknown");
		}
		// Positive but past the last representable Date.
		expect(installWeekFrom({ birthtimeMs: 8.64e15 + 1 })).toBe("unknown");
		expect(installWeekFrom({ birthtimeMs: Number.POSITIVE_INFINITY })).toBe("unknown");
		// Representable, but a five-digit year the loader would reject.
		expect(installWeekFrom({ birthtimeMs: Date.UTC(10000, 0, 5) })).toBe("unknown");
		expect(installWeekFrom(null)).toBe("unknown");
	});

	const sent = async (dir: string, now: Date) => {
		let properties: Record<string, unknown> = {};
		await sendUsagePing(dir, facts, {}, now, async (_url, init) => {
			properties = JSON.parse(String(init.body)).properties;
			return { ok: true };
		});
		return properties.install_week;
	};

	it("gives a fresh install the current week, then keeps it on later pings", async () => {
		const dir = tmp();
		// From the directory, not the clock, so a UTC Monday between the two cannot flake.
		const thisWeek = installWeekFrom(statSync(dir));
		expect(await sent(dir, new Date())).toBe(thisWeek);
		expect(loadUsagePingState(dir).installWeek).toBe(thisWeek);
		expect(await sent(dir, new Date(Date.now() + 40 * 86_400_000))).toBe(thisWeek);
	});

	it('keeps the week an existing install already has, "unknown" included', async () => {
		for (const installWeek of ["2025-W19", "unknown"]) {
			const dir = tmp();
			const state = { ...fresh, ...periodKeys(new Date("2026-10-13T09:00:00Z")), installWeek };
			writeFileSync(path.join(dir, "usage-ping.json"), JSON.stringify(state));
			expect(await sent(dir, wednesday)).toBe(installWeek);
			expect(loadUsagePingState(dir).installWeek).toBe(installWeek);
		}
	});

	it("re-derives a stored week that is not a valid ISO week", async () => {
		for (const installWeek of ["2026-W54", "2026-W00", "abc", "2026-W4"]) {
			const dir = tmp();
			writeFileSync(path.join(dir, "usage-ping.json"), JSON.stringify({ ...fresh, installWeek }));
			expect(loadUsagePingState(dir).installWeek).toBeNull();
		}
		const dir = tmp();
		writeFileSync(
			path.join(dir, "usage-ping.json"),
			JSON.stringify({ ...fresh, installWeek: "2026-W53" }),
		);
		expect(loadUsagePingState(dir).installWeek).toBe("2026-W53");
	});

	it("sends nothing from a folder that cannot keep its state, which would count every attempt", async () => {
		// An undatable folder's week is "unknown" (installWeekFrom(null) above); one that cannot
		// hold the state cannot claim a ping either, so it sends none rather than one per attempt.
		expect(await sent(path.join(tmp(), "gone"), wednesday)).toBeUndefined();
	});
});
