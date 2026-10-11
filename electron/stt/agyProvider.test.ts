import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgyTranscriptionProvider, parseAgyTranscript, runAgyProcess } from "./agyProvider";

function envelope(value: unknown) {
	return JSON.stringify({ status: "SUCCESS", response: JSON.stringify(value) });
}
const transcript = {
	detectedLanguage: "zh",
	segments: [{ text: "测试字幕", startSec: 0, endSec: 0.5 }],
};
const folders: string[] = [];
function folder() {
	const dir = mkdtempSync(path.join(os.tmpdir(), "openscreen-agy-test-"));
	folders.push(dir);
	return dir;
}
afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("AGY transcript boundary", () => {
	it("does not convert Chinese without a preference", () => {
		expect(parseAgyTranscript(envelope(transcript), 1).segments[0].text).toBe("测试字幕");
	});

	it("accepts only the final envelope and converts Chinese without invented word timing", () => {
		expect(parseAgyTranscript(envelope(transcript), 1, true)).toEqual({
			segments: [{ text: "測試字幕", startSec: 0, endSec: 0.5 }],
			wordSegments: [],
			detectedLanguage: "zh",
			backend: "agy-gemini",
		});
	});
	it("accepts a single enclosing JSON code fence but rejects prose around it", () => {
		const value = JSON.stringify(transcript);
		expect(
			parseAgyTranscript(
				JSON.stringify({ status: "SUCCESS", response: "```json\n" + value + "\n```" }),
				1,
			).segments,
		).toHaveLength(1);
		expect(() =>
			parseAgyTranscript(
				JSON.stringify({ status: "SUCCESS", response: "Here is a result: " + value }),
				1,
			),
		).toThrow();
	});

	it("accepts the observed per-phrase detected language variant", () => {
		expect(
			parseAgyTranscript(
				envelope({ segments: [{ ...transcript.segments[0], detectedLanguage: "zh-TW" }] }),
				1,
			).detectedLanguage,
		).toBe("zh-TW");
	});
	it.each([
		"permission denied: private-token",
		JSON.stringify({ status: "SUCCESS", response: "", denied_actions: [{ action: "command" }] }),
		envelope({ detectedLanguage: "unknown", segments: [] }),
		envelope({ ...transcript, segments: [{ text: "x", startSec: -1, endSec: 1 }] }),
		envelope({ ...transcript, segments: [{ text: "x", startSec: 0, endSec: 2 }] }),
		envelope({
			...transcript,
			segments: [
				{ text: "x", startSec: 0, endSec: 0.5 },
				{ text: "y", startSec: 0.25, endSec: 0.8 },
			],
		}),
	])("rejects unverified output without leaking it in errors", (output) => {
		expect(() => parseAgyTranscript(output, 1)).toThrow();
		try {
			parseAgyTranscript(output, 1);
		} catch (error) {
			expect(String(error)).not.toContain("private-token");
		}
	});
});

describe("AGY provider", () => {
	it("only exposes one temporary audio file, cleans it, and never bypasses permissions", async () => {
		let cwd = "";
		const run = vi.fn<typeof runAgyProcess>(async (_exe, args, options) => {
			cwd = options.cwd;
			expect(existsSync(path.join(cwd, "audio.wav"))).toBe(true);
			expect(args).toContain("--sandbox");
			expect(args).not.toContain("--dangerously-skip-permissions");
			return envelope(transcript);
		});
		const provider = new AgyTranscriptionProvider({
			resolveExecutable: () => "/fake/agy",
			run,
			timeoutMs: 1000,
		});
		const result = await provider.transcribe({
			samples: new Float32Array(16000),
			language: "zh",
			traditionalChinese: true,
		});
		expect(result.segments[0].text).toBe("測試字幕");
		expect(result.timing?.audioSec).toBe(1);
		expect(existsSync(cwd)).toBe(false);
	});
	it("cleans temporary audio even when the CLI rejects", async () => {
		let cwd = "";
		const provider = new AgyTranscriptionProvider({
			resolveExecutable: () => "/fake/agy",
			run: async (_exe, _args, options) => {
				cwd = options.cwd;
				throw new Error("offline");
			},
			timeoutMs: 1000,
		});
		await expect(provider.transcribe({ samples: new Float32Array(16000) })).rejects.toThrow(
			"offline",
		);
		expect(existsSync(cwd)).toBe(false);
	});
	it("does not spawn on missing CLI or a cancelled request", async () => {
		const run = vi.fn();
		const provider = new AgyTranscriptionProvider({
			resolveExecutable: () => null,
			run,
			timeoutMs: 1000,
		});
		await expect(provider.transcribe({ samples: new Float32Array(16000) })).rejects.toThrow(
			/unavailable/,
		);
		await expect(
			provider.transcribe({ samples: new Float32Array(16000), signal: AbortSignal.abort() }),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(run).not.toHaveBeenCalled();
	});
});

describe.skipIf(process.platform === "win32")("AGY subprocess isolation", () => {
	it("does not pass cloud credentials or echo stderr", async () => {
		vi.stubEnv("GMI_API_KEY", "private-token");
		try {
			const result = await runAgyProcess(
				process.execPath,
				[
					"-e",
					"process.stdout.write(String(process.env.GMI_API_KEY));process.stderr.write('private-token')",
				],
				{ cwd: folder(), timeoutMs: 2000 },
			);
			expect(result).toBe("undefined");
		} finally {
			vi.unstubAllEnvs();
		}
	});
	it("kills the process tree on cancellation", async () => {
		const cwd = folder();
		const controller = new AbortController();
		const code =
			"const fs=require('node:fs'); const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync('pids.json',JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);";
		const pending = runAgyProcess(process.execPath, ["-e", code], {
			cwd,
			timeoutMs: 5000,
			signal: controller.signal,
		});
		const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
		await vi.waitFor(() => expect(existsSync(path.join(cwd, "pids.json"))).toBe(true));
		const pids = JSON.parse(readFileSync(path.join(cwd, "pids.json"), "utf8")) as number[];
		controller.abort();
		await rejected;
		await vi.waitFor(() => {
			for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
		});
	});
	it("bounds time and output", async () => {
		await expect(
			runAgyProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
				cwd: folder(),
				timeoutMs: 30,
			}),
		).rejects.toThrow(/timed out/);
		await expect(
			runAgyProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(5*1024*1024))"], {
				cwd: folder(),
				timeoutMs: 2000,
			}),
		).rejects.toThrow(/size limit/);
	});
});
