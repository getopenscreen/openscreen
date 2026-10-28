import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasLiveCliSession, isAbandonedSession, type SessionOwner } from "./sessionData";

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

describe("hasLiveCliSession", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
		dirs.length = 0;
	});
	function userData(): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "os-cli-sessions-"));
		dirs.push(dir);
		return dir;
	}
	function addRun(root: string, owner: SessionOwner | null) {
		const run = path.join(root, "cli-sessions", "200-abc");
		fs.mkdirSync(run, { recursive: true });
		if (owner) fs.writeFileSync(path.join(run, "owner.json"), JSON.stringify(owner));
	}

	it("finds none when no CLI run ever started", () => {
		expect(hasLiveCliSession(userData(), alive, self)).toBe(false);
	});

	it("sees an agent's `openscreen mcp` run while its pid lives, and not after", () => {
		const root = userData();
		addRun(root, { ...self, pid: 200 });
		expect(hasLiveCliSession(root, alive, self)).toBe(true);
		expect(hasLiveCliSession(root, dead, self)).toBe(false);
	});

	it("does not count a folder whose run never wrote its owner", () => {
		const root = userData();
		addRun(root, null);
		expect(hasLiveCliSession(root, alive, self)).toBe(false);
	});
});
