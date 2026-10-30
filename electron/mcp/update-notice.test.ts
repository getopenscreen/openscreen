import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createOpenScreenMcpServer,
	type McpToolDeps,
	mcpInstructions,
} from "./openscreen-mcp-server";
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
		expect(notice).toContain("the OpenScreen app shows an update button");
		expect(notice).toContain("Never update OpenScreen yourself.");
	});

	// Through the server itself, as a client receives it in the initialize answer: a dropped
	// `updateNotice` between the deps and the instructions would pass the test below.
	it("reaches the client in the server's instructions", async () => {
		// Only what building the server reads; no tool is called.
		const deps = {
			transport: "stdio",
			editsAllowed: () => true,
			version: "2.1.2",
			updateNotice: "OpenScreen 2.2.0 is available.",
		} as McpToolDeps;
		const server = createOpenScreenMcpServer(deps, vi.fn());
		const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
		await server.connect(serverSide);
		const client = new Client({ name: "test", version: "1" });
		await client.connect(clientSide);
		try {
			expect(client.getInstructions()?.startsWith("OpenScreen 2.2.0 is available.\n")).toBe(true);
		} finally {
			await client.close();
		}
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

	it("looks again when the cached lookup is dated in the future", async () => {
		const dir = userData();
		writeFileSync(
			path.join(dir, "mcp-update-check.json"),
			JSON.stringify({ latestVersion: "2.1.2", checkedAt: 10_000 }),
		);
		const fetchLatest = release("v2.2.0");
		await refreshReleaseLookup({ userData: dir, currentVersion: "2.1.2", fetchLatest, now: 1000 });
		expect(fetchLatest).toHaveBeenCalledTimes(1);
		expect(readReleaseLookup(dir)).toEqual({ latestVersion: "2.2.0", checkedAt: 1000 });
	});

	it("reads a corrupt cache as no lookup at all", () => {
		const dir = userData();
		writeFileSync(path.join(dir, "mcp-update-check.json"), "{not json");
		expect(readReleaseLookup(dir)).toBeNull();
	});
});
