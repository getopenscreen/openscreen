import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	installWeekFrom,
	loadUsagePingState,
	periodKeys,
	planUsagePing,
	sendUsagePing,
	setUsagePingEnabled,
	type UsagePingFacts,
	type UsagePingState,
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

describe("install week", () => {
	it("dates the install by the userData directory's birthtime, never its mtime", () => {
		expect(installWeekFrom({ birthtimeMs: Date.parse("2025-05-07T12:00:00Z") })).toBe("2025-W19");
		// Filesystems that record no birthtime report 0; mtime would move, so no fallback.
		expect(installWeekFrom({ birthtimeMs: 0 })).toBe("unknown");
		expect(installWeekFrom({ birthtimeMs: Number.NaN })).toBe("unknown");
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

	it('sends "unknown" when the directory cannot be dated', async () => {
		expect(await sent(path.join(tmp(), "gone"), wednesday)).toBe("unknown");
	});
});
