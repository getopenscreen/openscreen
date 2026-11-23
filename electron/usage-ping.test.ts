import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
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
	updateUsagePingState,
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

/** The released builds' single file, which a version-less install starts from. */
const legacyFile = (dir: string) => path.join(dir, "usage-ping.json");
const versions = (dir: string) => readdirSync(path.join(dir, "usage-ping"));
const oneMore = (state: UsagePingState, name: string) => ({
	...state,
	tools: { ...state.tools, [name]: (state.tools[name] ?? 0) + 1 },
});

/**
 * Runs `script` with this module in another process. `ready` settles on its first output, and
 * fails with what it printed on stderr when it does not start or exits first; `stop` ends it.
 */
function runScript(script: string, ...args: string[]) {
	const child = spawn(process.execPath, [
		"--experimental-strip-types",
		"--no-warnings",
		script,
		path.join(__dirname, "usage-ping.ts"),
		...args,
	]);
	let out = "";
	let err = "";
	child.stdout.on("data", (data) => {
		out += data;
	});
	child.stderr.on("data", (data) => {
		err += data;
	});
	const exited = new Promise<number | null>((resolve) => {
		child.once("close", resolve);
		child.once("error", () => resolve(null));
	});
	const ready = new Promise<void>((resolve, reject) => {
		child.stdout.once("data", () => resolve());
		child.once("error", reject);
		void exited.then((code) => reject(new Error(`exited (${code}) before it was ready: ${err}`)));
	});
	return {
		ready,
		exited,
		output: () => out,
		stop: async () => {
			if (child.exitCode === null && child.signalCode === null) child.kill();
			await exited;
		},
	};
}

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

	it("starts no request when the box is unticked between the claim and the request", async () => {
		const dir = tmp();
		countToolCall(dir, "store", "getFrames", {});
		let requests = 0;
		// Another process's tray, landing right after this ping claimed the counts.
		await sendUsagePing(
			dir,
			facts,
			{},
			wednesday,
			async () => {
				requests++;
				return { ok: true };
			},
			() => setUsagePingEnabled(dir, false),
		);
		expect(requests).toBe(0);
		// The opt-out took the claim and its counts with it.
		expect(loadUsagePingState(dir)).toMatchObject({ enabled: false, tools: {}, sending: null });
	});

	it("hands the request over in the state before it starts, so an opt-out after it finds it gone", async () => {
		const dir = tmp();
		countToolCall(dir, "store", "getFrames", {});
		let handedOver: boolean | undefined;
		await sendUsagePing(dir, facts, {}, wednesday, async () => {
			// What another process unticking the box now would find: this request already gone.
			handedOver = loadUsagePingState(dir).sending?.dispatched;
			return { ok: true };
		});
		expect(handedOver).toBe(true);
		expect(loadUsagePingState(dir)).toMatchObject({ day: "2026-10-14", sending: null });
	});
});

describe("the versions of the state", () => {
	it("lose no call when several processes count at once", async () => {
		const dir = tmp();
		// Three other processes run this module and count 30 calls each, while this one counts 30.
		// They load first, then wait for one signal, so all four count over the same moments.
		const script = path.join(dir, "counter.mjs");
		const go = path.join(dir, "go");
		writeFileSync(
			script,
			`import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
const [modulePath, dir, go] = process.argv.slice(2);
const { countToolCall } = await import(pathToFileURL(modulePath).href);
process.stdout.write("ready\\n");
const until = Date.now() + 30_000;
while (!existsSync(go)) {
	if (Date.now() > until) process.exit(2);
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
}
for (let i = 0; i < 30; i++) countToolCall(dir, "store", "getFrames", {});
`,
		);
		const counters = Array.from({ length: 3 }, () => runScript(script, dir, go));
		try {
			await Promise.all(counters.map((counter) => counter.ready));
			writeFileSync(go, "");
			for (let i = 0; i < 30; i++) countToolCall(dir, "store", "addZoom", {});
			expect(await Promise.all(counters.map((counter) => counter.exited))).toEqual([0, 0, 0]);
		} finally {
			await Promise.all(counters.map((counter) => counter.stop()));
		}
		expect(loadUsagePingState(dir).tools).toEqual({ getFrames: 90, addZoom: 30 });
	}, 30_000);

	it("start a change over on the newer state when another lands between its read and its write", () => {
		const dir = tmp();
		countToolCall(dir, "store", "getFrames", {});
		let calls = 0;
		updateUsagePingState(dir, (state) => {
			// Another process counts after this change read the state, before it wrote.
			if (calls++ === 0) countToolCall(dir, "store", "addZoom", {});
			return oneMore(state, "getFrames");
		});
		// Read again on the newer state: neither count is lost, and this one landed once.
		expect(calls).toBe(2);
		expect(loadUsagePingState(dir).tools).toEqual({ getFrames: 2, addZoom: 1 });
	});

	it("never let a change land on an older state than the box's choice", () => {
		const dir = tmp();
		countToolCall(dir, "store", "getFrames", {});
		let calls = 0;
		updateUsagePingState(dir, (state) => {
			// The tray unticks the box after this count read the state, before it wrote.
			if (calls++ === 0) setUsagePingEnabled(dir, false);
			return state.enabled ? oneMore(state, "getFrames") : null;
		});
		expect(calls).toBe(2);
		expect(loadUsagePingState(dir)).toMatchObject({ enabled: false, tools: {} });
	});

	it("do not let a change stand whose process stalled while its number was freed", () => {
		const dir = tmp();
		countToolCall(dir, "store", "getFrames", {});
		let calls = 0;
		updateUsagePingState(dir, (state) => {
			// Stalled long enough for 25 changes to land and the number it is about to take
			// to be freed by the collection of old versions.
			if (calls++ === 0) for (let i = 0; i < 25; i++) countToolCall(dir, "store", "addZoom", {});
			return oneMore(state, "getFrames");
		});
		// Its first write took a freed number below the newest ones: it did not stand, and it
		// was made again on the newest state.
		expect(calls).toBe(2);
		expect(loadUsagePingState(dir).tools).toEqual({ getFrames: 2, addZoom: 25 });
	});

	it("count a change once however many land on top of it before it checks", () => {
		const dir = tmp();
		countToolCall(dir, "store", "getFrames", {});
		let calls = 0;
		updateUsagePingState(
			dir,
			(state) => {
				calls++;
				return oneMore(state, "getFrames");
			},
			// Time enough to make it again, were it found not to have landed.
			60_000,
			{
				// It wrote, then stalled: 129 changes landed on top of it, and the collection took
				// every version between it and the newest.
				afterWrite: () => {
					for (let i = 0; i < 129; i++) countToolCall(dir, "store", "addZoom", {});
				},
			},
		);
		// The change built on it marked it as landed: it is not made again, and leaves no file.
		expect(calls).toBe(1);
		expect(loadUsagePingState(dir).tools).toEqual({ getFrames: 2, addZoom: 129 });
		expect(versions(dir).every((name) => /^\d+\.json$/.test(name))).toBe(true);
	});

	it("never take a version given a freed number for the newest, from a listing made before", async () => {
		const dir = tmp();
		const sync = tmp();
		const say = (name: string) => writeFileSync(path.join(sync, name), "");
		const wait = (name: string) => {
			const until = Date.now() + 20_000;
			while (!existsSync(path.join(sync, name))) {
				if (Date.now() > until) throw new Error(`the other process never said "${name}"`);
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
			}
		};
		// Another process unticks the box: it reads the state and stalls before writing, then,
		// once written, stalls again before checking that its version landed.
		const script = path.join(sync, "opt-out.mjs");
		writeFileSync(
			script,
			`import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const [modulePath, dir, sync] = process.argv.slice(2);
const { updateUsagePingState } = await import(pathToFileURL(modulePath).href);
process.stdout.write("ready\\n");
const say = (name) => writeFileSync(path.join(sync, name), "");
const until = Date.now() + 30_000;
const wait = (name) => {
	while (!existsSync(path.join(sync, name))) {
		if (Date.now() > until) process.exit(2);
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
	}
};
let read = false;
let wrote = false;
const stored = updateUsagePingState(
	dir,
	(state) => {
		if (!read) { read = true; say("read"); wait("write"); }
		return { ...state, enabled: false, tools: {}, sending: null };
	},
	60_000,
	{ afterWrite: () => { if (!wrote) { wrote = true; say("wrote"); wait("check"); } } },
);
process.stdout.write(JSON.stringify(stored));
`,
		);
		countToolCall(dir, "store", "getFrames", {});
		const optOut = runScript(script, dir, sync);
		try {
			await optOut.ready;
			// It read version 1, and will write 2; another count takes 2 first.
			wait("read");
			countToolCall(dir, "store", "getFrames", {});
			let listed = false;
			updateUsagePingState(dir, (state) => oneMore(state, "addZoom"), 60_000, {
				afterList: () => {
					if (listed) return;
					listed = true;
					// This change listed 1 and 2, then stalled: 25 changes landed and the collection
					// freed both numbers. The opt-out took 2, a version that is not the newest.
					for (let i = 0; i < 25; i++) countToolCall(dir, "store", "getFrames", {});
					say("write");
					wait("wrote");
				},
			});
			say("check");
			expect(await optOut.exited).toBe(0);
		} finally {
			await optOut.stop();
		}
		// The opt-out's first version was never taken for the newest, so never marked as landed:
		// it found so, and unticked the box again on the newest state.
		expect(JSON.parse(optOut.output().trim().split("\n").at(-1) ?? "")).toMatchObject({
			enabled: false,
		});
		expect(loadUsagePingState(dir)).toMatchObject({ enabled: false, tools: {} });
	}, 30_000);

	it("ignore a version its writer never numbered, and clear it away once its writer is gone", () => {
		const dir = tmp();
		setUsagePingEnabled(dir, false);
		// Written whole, but its writer died before giving it a number: it says the box is ticked.
		const stray = path.join(dir, "usage-ping", ".0123456789abcdef.part");
		writeFileSync(stray, JSON.stringify({ ...fresh, tools: { getFrames: 9 } }));
		// Its writer still runs, stalled: it checks once resumed.
		const stalled = path.join(dir, "usage-ping", ".fedcba9876543210.part");
		writeFileSync(stalled, JSON.stringify({ ...fresh, pid: process.pid }));
		expect(loadUsagePingState(dir)).toMatchObject({ enabled: false, tools: {} });
		const old = new Date(Date.now() - 5 * 60_000);
		utimesSync(stray, old, old);
		utimesSync(stalled, old, old);
		setUsagePingEnabled(dir, false);
		expect(versions(dir).filter((name) => name.endsWith(".part"))).toEqual([
			".fedcba9876543210.part",
		]);
	});

	it("count and send nothing over a newest version that does not read, which may be an opt-out", async () => {
		const dir = tmp();
		countToolCall(dir, "store", "getFrames", {});
		// The newest version is there but cannot be read: a folder stands in for a file that will
		// not open.
		const head = path.join(dir, "usage-ping", "2.json");
		mkdirSync(head);
		expect(loadUsagePingState(dir).enabled).toBe(false);
		countToolCall(dir, "store", "getFrames", {});
		let requests = 0;
		await sendUsagePing(dir, facts, {}, wednesday, async () => {
			requests++;
			return { ok: true };
		});
		expect(requests).toBe(0);
		expect(versions(dir).sort()).toEqual(["1.json", "2.json"]);
		// Readable again, its opt-out holds: nothing was made over it meanwhile.
		rmSync(head, { recursive: true });
		writeFileSync(head, JSON.stringify({ ...fresh, enabled: false, commit: "0123456789abcdef" }));
		expect(loadUsagePingState(dir).enabled).toBe(false);
	});

	it("recover from a newest version that does not read when the box's choice is made again", () => {
		const dir = tmp();
		countToolCall(dir, "store", "getFrames", {});
		writeFileSync(path.join(dir, "usage-ping", "2.json"), '{"enabled":');
		expect(setUsagePingEnabled(dir, true)).toBe(true);
		countToolCall(dir, "store", "getFrames", {});
		expect(loadUsagePingState(dir)).toMatchObject({ enabled: true, tools: { getFrames: 1 } });
	});

	it("say whether the box's choice was stored, so the tray shows only a stored one", () => {
		expect(setUsagePingEnabled(tmp(), false)).toBe(true);
		expect(setUsagePingEnabled(path.join(tmp(), "gone"), false)).toBe(false);
	});

	it("keep the newest versions only, and nothing beside them", () => {
		const dir = tmp();
		for (let i = 0; i < 30; i++) countToolCall(dir, "store", "getFrames", {});
		const kept = versions(dir);
		expect(kept.length).toBeLessThanOrEqual(20);
		expect(kept.every((name) => /^\d+\.json$/.test(name))).toBe(true);
		expect(loadUsagePingState(dir).tools).toEqual({ getFrames: 30 });
		// The released builds' file is not written.
		expect(readdirSync(dir)).toEqual(["usage-ping"]);
	});
});

describe("the opt-out", () => {
	it("starts from the released builds' file, its opt-out included", () => {
		const dir = tmp();
		writeFileSync(legacyFile(dir), JSON.stringify({ ...fresh, enabled: false }));
		expect(loadUsagePingState(dir).enabled).toBe(false);
		countToolCall(dir, "store", "getFrames", {});
		expect(loadUsagePingState(dir).tools).toEqual({});
	});

	it("holds when a released build, downgraded to, unticks the box in its own file", () => {
		const dir = tmp();
		countToolCall(dir, "store", "getFrames", {});
		writeFileSync(legacyFile(dir), JSON.stringify({ ...fresh, enabled: false }));
		const later = new Date(Date.now() + 5_000);
		utimesSync(legacyFile(dir), later, later);
		expect(loadUsagePingState(dir).enabled).toBe(false);
		// Ticked there afterwards, it changes nothing: only an opt-out is taken from that file.
		setUsagePingEnabled(dir, false);
		writeFileSync(legacyFile(dir), JSON.stringify({ ...fresh, enabled: true }));
		const later2 = new Date(Date.now() + 10_000);
		utimesSync(legacyFile(dir), later2, later2);
		expect(loadUsagePingState(dir).enabled).toBe(false);
	});

	it("lets the box ticked since outlast that opt-out, however that file is dated", () => {
		const dir = tmp();
		countToolCall(dir, "store", "getFrames", {});
		writeFileSync(legacyFile(dir), JSON.stringify({ ...fresh, enabled: false }));
		// Dated ahead of the clock: every version made since is older than it.
		const ahead = new Date(Date.now() + 60_000);
		utimesSync(legacyFile(dir), ahead, ahead);
		expect(loadUsagePingState(dir).enabled).toBe(false);
		expect(setUsagePingEnabled(dir, true)).toBe(true);
		expect(loadUsagePingState(dir).enabled).toBe(true);
		// Written there again afterwards, the opt-out holds anew.
		writeFileSync(legacyFile(dir), JSON.stringify({ ...fresh, enabled: false }));
		const later = new Date(Date.now() + 120_000);
		utimesSync(legacyFile(dir), later, later);
		expect(loadUsagePingState(dir).enabled).toBe(false);
	});

	it("counts nothing while that file does not read, and never takes it as read", () => {
		// The file a released build wrote is there but cannot be read for now: a folder stands in
		// for it. Once it reads, with the same date, it turns out to hold an opt-out.
		const seen = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
		const readable = (dir: string) => {
			rmSync(legacyFile(dir), { recursive: true });
			writeFileSync(legacyFile(dir), JSON.stringify({ ...fresh, enabled: false }));
			utimesSync(legacyFile(dir), seen, seen);
		};
		const first = tmp();
		mkdirSync(legacyFile(first));
		utimesSync(legacyFile(first), seen, seen);
		countToolCall(first, "store", "getFrames", {});
		expect(versions(first)).toEqual([]);
		readable(first);
		expect(loadUsagePingState(first).enabled).toBe(false);

		const later = tmp();
		countToolCall(later, "store", "getFrames", {});
		mkdirSync(legacyFile(later));
		utimesSync(legacyFile(later), seen, seen);
		expect(loadUsagePingState(later).enabled).toBe(false);
		countToolCall(later, "store", "getFrames", {});
		readable(later);
		expect(loadUsagePingState(later)).toMatchObject({ enabled: false, tools: { getFrames: 1 } });
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
		// Claimed a moment ago by a process that has exited: taken back at once.
		const gone = spawn(process.execPath, ["-e", ""]);
		await new Promise((resolve) => gone.on("exit", resolve));
		const dead = { id: "dead", at: Date.now(), tools: { getFrames: 3 }, pid: gone.pid };
		updateUsagePingState(dir, () => ({ ...fresh, tools: { addZoom: 1 }, sending: dead }));
		expect((await sentBy(dir, wednesday))?.mcp_tools).toEqual({ getFrames: 3, addZoom: 1 });
		expect(loadUsagePingState(dir)).toMatchObject({ tools: {}, sending: null });
		// A claim naming no process is taken back once it is older than a minute.
		const old = { id: "old", at: Date.now() - 10 * 60_000, tools: { getFrames: 2 } };
		updateUsagePingState(dir, () => ({ ...fresh, sending: old }));
		expect((await sentBy(dir, wednesday))?.mcp_tools).toEqual({ getFrames: 2 });
	});

	it("are not sent again while the process that claimed them runs, held past a minute", async () => {
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
		// The first is held past its claim's minute, as on a machine that slept mid-request.
		updateUsagePingState(dir, (state) =>
			state.sending
				? { ...state, sending: { ...state.sending, at: Date.now() - 10 * 60_000 } }
				: null,
		);
		// Another ping starts: the process that claimed the counts still runs, so they stay its.
		await sendUsagePing(dir, { ...facts, surface: "mcp" }, {}, wednesday, async (_url, init) => {
			sent.push(JSON.parse(String(init.body)).properties);
			return { ok: true };
		});
		answer(true);
		await first;
		expect(sent).toHaveLength(1);
		expect(sent[0].mcp_tools).toEqual({ getFrames: 1 });
		expect(loadUsagePingState(dir)).toMatchObject({ day: "2026-10-14", tools: {}, sending: null });
	});

	it("never move the day back when an older ping answers after a later one", async () => {
		const dir = tmp();
		let answer: (ok: boolean) => void = () => undefined;
		const wednesdayPing = sendUsagePing(
			dir,
			facts,
			{},
			wednesday,
			() =>
				new Promise((resolve) => {
					answer = (ok) => resolve({ ok });
				}),
		);
		// Held past an hour, its claim is taken back by Thursday's ping, which goes through.
		updateUsagePingState(dir, (state) =>
			state.sending
				? { ...state, sending: { ...state.sending, at: Date.now() - 2 * 60 * 60_000 } }
				: null,
		);
		await sendUsagePing(dir, facts, {}, new Date("2026-10-15T09:00:00Z"), async () => ({
			ok: true,
		}));
		expect(loadUsagePingState(dir).day).toBe("2026-10-15");
		// Wednesday's answer comes last: Thursday stays the day recorded.
		answer(true);
		await wednesdayPing;
		expect(loadUsagePingState(dir)).toMatchObject({ day: "2026-10-15", sending: null });
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
		writeFileSync(legacyFile(dir), JSON.stringify({ ...fresh, tools }));
		expect(loadUsagePingState(dir).tools).toEqual({ getFrames: 3 });
		writeFileSync(legacyFile(dir), JSON.stringify({ ...fresh, tools: "x" }));
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
			writeFileSync(legacyFile(dir), JSON.stringify(state));
			expect(await sent(dir, wednesday)).toBe(installWeek);
			expect(loadUsagePingState(dir).installWeek).toBe(installWeek);
		}
	});

	it("re-derives a stored week that is not a valid ISO week", async () => {
		for (const installWeek of ["2026-W54", "2026-W00", "abc", "2026-W4"]) {
			const dir = tmp();
			writeFileSync(legacyFile(dir), JSON.stringify({ ...fresh, installWeek }));
			expect(loadUsagePingState(dir).installWeek).toBeNull();
		}
		const dir = tmp();
		writeFileSync(legacyFile(dir), JSON.stringify({ ...fresh, installWeek: "2026-W53" }));
		expect(loadUsagePingState(dir).installWeek).toBe("2026-W53");
	});

	it("sends nothing from a folder that cannot keep its state, which would count every attempt", async () => {
		// An undatable folder's week is "unknown" (installWeekFrom(null) above); one that cannot
		// hold the state cannot claim a ping either, so it starts no request rather than one per
		// attempt.
		let requests = 0;
		await sendUsagePing(path.join(tmp(), "gone"), facts, {}, wednesday, async () => {
			requests++;
			return { ok: true };
		});
		expect(requests).toBe(0);
	});
});
