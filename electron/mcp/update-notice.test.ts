import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mcpInstructions } from "./openscreen-mcp-server";
import {
	RELEASE_LOOKUP_INTERVAL_MS,
	readReleaseLookup,
	refreshReleaseLookup,
	updateNotice,
} from "./update-notice";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	dirs.length = 0;
});
function userData(): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), "os-mcp-update-"));
	dirs.push(dir);
	return dir;
}

function release(tag: string) {
	return vi.fn(async () => ({
		ok: true,
		status: 200,
		json: async () => ({
			tag_name: tag,
			html_url: `https://github.com/getopenscreen/openscreen/releases/tag/${tag}`,
			draft: false,
			prerelease: false,
		}),
	}));
}

describe("updateNotice", () => {
	it("says nothing without a lookup, or when the running version is the latest or newer", () => {
		expect(updateNotice("2.1.2", null)).toBeNull();
		expect(updateNotice("2.1.2", { latestVersion: "2.1.2", checkedAt: 0 })).toBeNull();
		expect(updateNotice("2.2.0-rc.1", { latestVersion: "2.1.2", checkedAt: 0 })).toBeNull();
	});

	it("says nothing rather than throw on a version it cannot read", () => {
		expect(updateNotice("2.1.2", { latestVersion: "not-a-version", checkedAt: 0 })).toBeNull();
	});

	// The user updates, not the agent: the line hands them the news and keeps the agent off it.
	it("names both versions and leaves the update to the user", () => {
		const notice = updateNotice("2.1.2", { latestVersion: "2.2.0", checkedAt: 0 });
		expect(notice).toContain("OpenScreen 2.2.0 is available; this is 2.1.2.");
		expect(notice).toContain("opening the OpenScreen app");
		expect(notice).toContain("Never update OpenScreen yourself.");
	});

	it("opens the stdio instructions, ahead of the editing guidance", () => {
		const instructions = mcpInstructions({
			transport: "stdio",
			editsAllowed: true,
			updateNotice: "OpenScreen 2.2.0 is available.",
		});
		expect(instructions.startsWith("OpenScreen 2.2.0 is available.\n")).toBe(true);
		expect(mcpInstructions({ transport: "stdio", editsAllowed: true })).not.toContain(
			"is available",
		);
	});
});

describe("refreshReleaseLookup", () => {
	it("stores the latest release for the next session to read", async () => {
		const dir = userData();
		await refreshReleaseLookup({
			userData: dir,
			currentVersion: "2.1.2",
			fetchLatest: release("v2.2.0"),
			now: 1000,
		});
		expect(readReleaseLookup(dir)).toEqual({ latestVersion: "2.2.0", checkedAt: 1000 });
	});

	it("asks GitHub at most once per interval", async () => {
		const dir = userData();
		const fetchLatest = release("v2.2.0");
		await refreshReleaseLookup({ userData: dir, currentVersion: "2.1.2", fetchLatest, now: 0 });
		await refreshReleaseLookup({
			userData: dir,
			currentVersion: "2.1.2",
			fetchLatest,
			now: RELEASE_LOOKUP_INTERVAL_MS - 1,
		});
		expect(fetchLatest).toHaveBeenCalledTimes(1);
		await refreshReleaseLookup({
			userData: dir,
			currentVersion: "2.1.2",
			fetchLatest,
			now: RELEASE_LOOKUP_INTERVAL_MS,
		});
		expect(fetchLatest).toHaveBeenCalledTimes(2);
	});

	it("reads a corrupt cache as no lookup at all", () => {
		const dir = userData();
		writeFileSync(path.join(dir, "mcp-update-check.json"), "{not json");
		expect(readReleaseLookup(dir)).toBeNull();
	});
});
