import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadAutoZoomEnabled, saveAutoZoomEnabled } from "./recording-settings";

const temps: string[] = [];
const tmp = () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "openscreen-recording-settings-"));
	temps.push(dir);
	return dir;
};
afterEach(() => {
	for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("recording settings", () => {
	it("defaults to on for absent, malformed, and invalid settings", () => {
		const dir = tmp();
		expect(loadAutoZoomEnabled(dir)).toBe(true);
		for (const raw of ["{broken", "null", "[]", "42", "{}", '{"autoZoomEnabled":"false"}']) {
			writeFileSync(path.join(dir, "recording-settings.json"), raw);
			expect(loadAutoZoomEnabled(dir)).toBe(true);
		}
	});

	it("round-trips false and true without overwriting unrelated keys", () => {
		const dir = tmp();
		const file = path.join(dir, "recording-settings.json");
		writeFileSync(file, '{"futurePreference":"keep"}');
		for (const enabled of [false, true]) {
			saveAutoZoomEnabled(dir, enabled);
			expect(loadAutoZoomEnabled(dir)).toBe(enabled);
			expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
				futurePreference: "keep",
				autoZoomEnabled: enabled,
			});
		}
	});

	it("loads the disabled preference in a separate Node process", () => {
		const dir = tmp();
		saveAutoZoomEnabled(dir, false);
		const moduleUrl = pathToFileURL(path.resolve("electron/recording-settings.ts")).href;
		const result = spawnSync(
			process.execPath,
			[
				"--experimental-strip-types",
				"--input-type=module",
				"-e",
				`import { loadAutoZoomEnabled } from ${JSON.stringify(moduleUrl)}; process.stdout.write(JSON.stringify(loadAutoZoomEnabled(process.argv[1])));`,
				dir,
			],
			{ encoding: "utf8" },
		);
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toBe("false");
	});

	it("rejects invalid writes and reports a failed disk write", () => {
		const dir = tmp();
		saveAutoZoomEnabled(dir, false);
		expect(() => saveAutoZoomEnabled(dir, "false" as unknown as boolean)).toThrow(TypeError);
		expect(loadAutoZoomEnabled(dir)).toBe(false);
		expect(() => saveAutoZoomEnabled(path.join(dir, "missing"), true)).toThrow();
	});
});
