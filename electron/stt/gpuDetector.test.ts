import { afterEach, describe, expect, it } from "vitest";
import { binaryNameForBackend, candidateBinaryPaths, detectGpuBackend } from "./gpuDetector";

describe("gpuDetector", () => {
	afterEach(() => {
		delete process.env.OPENSCREEN_WHISPER_SERVER_EXE;
	});

	it("returns a whisper.cpp backend for the current platform", async () => {
		const result = await detectGpuBackend();
		expect(["whispercpp-metal", "whispercpp-vulkan", "whispercpp-cpu"]).toContain(result.backend);
		expect(typeof result.reason).toBe("string");
		expect(result.reason.length).toBeGreaterThan(0);
	});

	it("binaryNameForBackend returns a single name per platform, with .exe on win32", () => {
		const originalPlatform = process.platform;
		Object.defineProperty(process, "platform", { value: "linux", configurable: true });
		try {
			expect(binaryNameForBackend("whispercpp-vulkan")).toBe("whisper-stt-server");
			expect(binaryNameForBackend("whispercpp-cpu")).toBe("whisper-stt-server");
		} finally {
			Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
		}
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		try {
			expect(binaryNameForBackend("whispercpp-vulkan")).toBe("whisper-stt-server.exe");
			expect(binaryNameForBackend("whispercpp-cpu")).toBe("whisper-stt-server.exe");
		} finally {
			Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
		}
	});

	it("candidateBinaryPaths surfaces bin candidates under the repo root, .exe-aware on win32", () => {
		const originalPlatform = process.platform;
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		try {
			const here = "C:/fake/repo";
			const paths = candidateBinaryPaths(here);
			expect(paths.length).toBeGreaterThanOrEqual(2);
			const resolved = paths.map((p) => p.replace(/\\/g, "/"));
			// The tag is `${platform}-${arch}`, and only `platform` is stubbed above —
			// `arch` stays the HOST's. Hardcoding `win32-x64` therefore asserted that the
			// host is x64, so this passed on CI (linux-x64) and on an Intel Mac but failed
			// on every Apple Silicon machine, where the tag is `win32-arm64`.
			expect(resolved).toContain(
				`${here}/electron/native/bin/win32-${process.arch}/whisper-stt-server.exe`,
			);
		} finally {
			Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
		}
	});

	/**
	 * Windows on ARM ships no whisper build: `build-whisper-stt.yml` produces
	 * `win32-x64` only, and `scripts/build-whisper-stt.sh` has no acceleration case
	 * for `win32-arm64` at all. An arm64 package therefore resolves a tag that will
	 * never contain the helper, and speech-to-text fails with "binary not found" —
	 * observed on a Snapdragon X Elite.
	 *
	 * The x64 helper runs fine there: Windows emulates it per-process, and it is
	 * spawned as its own process rather than loaded into ours. Verified by running
	 * the extracted x64 `whisper-stt-server.exe` on that machine — it starts, loads
	 * its DLLs and parses its arguments. Falling back to it beats shipping an arm64
	 * build with no transcription until a native helper exists.
	 *
	 * The fallback tag matters for more than the .exe: the x64 helper needs the x64
	 * CRT and ggml DLLs beside it, and `win32-arm64/` holds the ARM64 ones. Pointing
	 * at `win32-x64/` keeps the helper next to the libraries it actually links.
	 */
	it("candidateBinaryPaths falls back to the x64 helper on Windows on ARM", () => {
		const originalPlatform = process.platform;
		const originalArch = process.arch;
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		Object.defineProperty(process, "arch", { value: "arm64", configurable: true });
		try {
			const here = "C:/fake/repo";
			const resolved = candidateBinaryPaths(here).map((p) => p.replace(/\\/g, "/"));
			const arm = `${here}/electron/native/bin/win32-arm64/whisper-stt-server.exe`;
			const x64 = `${here}/electron/native/bin/win32-x64/whisper-stt-server.exe`;
			expect(resolved).toContain(arm);
			expect(resolved).toContain(x64);
			// Native first: the moment an arm64 helper exists it must win.
			expect(resolved.indexOf(arm)).toBeLessThan(resolved.indexOf(x64));
		} finally {
			Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
			Object.defineProperty(process, "arch", { value: originalArch, configurable: true });
		}
	});

	it("candidateBinaryPaths prepends env override when set", () => {
		process.env.OPENSCREEN_WHISPER_SERVER_EXE = "/custom/path/whisper-stt-server";
		const here = "/fake/repo";
		const paths = candidateBinaryPaths(here);
		expect(paths[0]).toBe("/custom/path/whisper-stt-server");
		delete process.env.OPENSCREEN_WHISPER_SERVER_EXE;
	});

	it("candidateBinaryPaths honours OPENSCREEN_WHISPER_SERVER_EXE when set", () => {
		process.env.OPENSCREEN_WHISPER_SERVER_EXE = "/custom/path/whisper-stt-server";
		const paths = candidateBinaryPaths("/fake/repo");
		expect(paths[0]).toBe("/custom/path/whisper-stt-server");
	});
});
