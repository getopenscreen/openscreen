import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
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

const fresh: UsagePingState = { enabled: true, day: null, week: null, month: null };
const facts: UsagePingFacts = { version: "2.0.0", os: "win32", arch: "x64", channel: "store" };
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
		expect(bodies[0].properties).toEqual({
			$process_person_profile: false,
			$geoip_disable: true,
			version: "2.0.0",
			os: "win32",
			arch: "x64",
			channel: "store",
			first_this_week: true,
			first_this_month: true,
		});
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
