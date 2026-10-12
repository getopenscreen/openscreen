import { describe, expect, it } from "vitest";
import { isAbandonedSession, type SessionOwner } from "./sessionData";

const DAY = 24 * 60 * 60 * 1000;
const self: SessionOwner = { host: "box", pidNamespace: "pid:[1]", pid: 100 };
const dead = () => false;
const alive = () => true;

describe("isAbandonedSession", () => {
	it("retires a run on this host and namespace whose pid is gone", () => {
		expect(isAbandonedSession({ ...self, pid: 300 }, DAY, self, dead)).toBe(true);
	});

	it("keeps a run whose pid is still alive", () => {
		expect(isAbandonedSession({ ...self, pid: 200 }, DAY, self, alive)).toBe(false);
	});

	it("never judges a pid from another host or pid namespace", () => {
		expect(isAbandonedSession({ ...self, host: "other", pid: 300 }, DAY, self, dead)).toBe(false);
		expect(
			isAbandonedSession({ ...self, pidNamespace: "pid:[2]", pid: 300 }, DAY, self, dead),
		).toBe(false);
	});

	it("keeps a folder with no owner file until it is too old to be live", () => {
		expect(isAbandonedSession(null, DAY, self, dead)).toBe(false);
		expect(isAbandonedSession(null, 8 * DAY, self, dead)).toBe(true);
	});

	it("retires any owner left unrefreshed for longer than a live run allows", () => {
		expect(isAbandonedSession({ ...self, host: "other" }, 8 * DAY, self, alive)).toBe(true);
	});
});
