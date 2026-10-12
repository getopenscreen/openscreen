import path from "node:path";
import { describe, expect, it } from "vitest";
import { cliSessionDataDir, staleCliSessionDirs } from "./sessionData";

describe("cliSessionDataDir", () => {
	it("gives each process its own folder under userData, apart from the GUI's profile", () => {
		const userData = path.join("home", "openscreen");
		expect(cliSessionDataDir(userData, 4242)).toBe(path.join(userData, "cli-sessions", "4242"));
		expect(cliSessionDataDir(userData, 4242)).not.toBe(cliSessionDataDir(userData, 4243));
	});
});

describe("staleCliSessionDirs", () => {
	it("keeps its own folder and those of live runs, and returns those of exited runs", () => {
		const alive = new Set([200]);
		expect(staleCliSessionDirs(["100", "200", "300"], 100, (pid) => alive.has(pid))).toEqual([
			"300",
		]);
	});

	it("never touches a folder whose name is not a pid", () => {
		expect(staleCliSessionDirs(["notes", "12a", ".DS_Store"], 1, () => false)).toEqual([]);
	});
});
