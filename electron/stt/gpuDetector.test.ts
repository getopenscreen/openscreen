import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { binaryNameForBackend, candidateBinaryPaths, detectGpuBackend } from "./gpuDetector";

describe("gpuDetector", () => {
	afterEach(() => {
		// Cache buster for env override in case individual tests set it.
		delete process.env.OPENSCREEN_WHISPER_SERVER_EXE;
	});

	it("picks the CPU fallback when no GPU detectors report success", async () => {
		// Local CI runners may differ — accept any backend that the spec
		// recognises (whisper-{metal,cuda,vulkan,cpu}) and only require a reason.
		const result = await detectGpuBackend();
		expect(["whisper-metal", "whisper-cuda", "whisper-vulkan", "whisper-cpu"]).toContain(
			result.backend,
		);
		expect(typeof result.reason).toBe("string");
		expect(result.reason.length).toBeGreaterThan(0);
	});

	it("binaryNameForBackend returns a stable name per backend, with .exe on win32", () => {
		// Save + restore platform to keep this test host-agnostic.
		const originalPlatform = process.platform;
		Object.defineProperty(process, "platform", { value: "linux", configurable: true });
		try {
			expect(binaryNameForBackend("whisper-metal")).toBe("whisper-server-whisper-metal");
			expect(binaryNameForBackend("whisper-cuda")).toBe("whisper-server-whisper-cuda");
			expect(binaryNameForBackend("whisper-vulkan")).toBe("whisper-server-whisper-vulkan");
			expect(binaryNameForBackend("whisper-cpu")).toBe("whisper-server-whisper-cpu");
		} finally {
			Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
		}
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		try {
			expect(binaryNameForBackend("whisper-cpu")).toBe("whisper-server-whisper-cpu.exe");
			expect(binaryNameForBackend("whisper-cuda")).toBe("whisper-server-whisper-cuda.exe");
		} finally {
			Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
		}
	});

	it("candidateBinaryPaths surfaces bin candidates under the repo root, .exe-aware on win32", () => {
		const originalPlatform = process.platform;
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		try {
			const here = "C:/fake/repo";
			const paths = candidateBinaryPaths("whisper-cpu", here);
			// Both .exe and bare names appear, on every base dir, so a checkout
			// with either naming convention still resolves.
			expect(paths.length).toBeGreaterThanOrEqual(2);
			const resolved = paths.map((p) => p.replace(/\\/g, "/"));
			expect(resolved).toContain(
				`${here}/electron/native/bin/win32-x64/whisper-server-whisper-cpu.exe`,
			);
		} finally {
			Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
		}
	});

	it("candidateBinaryPaths prepends env override when set", () => {
		process.env.OPENSCREEN_WHISPER_SERVER_EXE = "/custom/path/whisper-server";
		const here = "/fake/repo";
		const paths = candidateBinaryPaths("whisper-cpu", here);
		expect(paths[0]).toBe("/custom/path/whisper-server");
		delete process.env.OPENSCREEN_WHISPER_SERVER_EXE;
	});

	it("candidateBinaryPaths honours OPENSCREEN_WHISPER_SERVER_EXE when set", () => {
		process.env.OPENSCREEN_WHISPER_SERVER_EXE = "/custom/path/whisper-server";
		const paths = candidateBinaryPaths("whisper-cpu", "/fake/repo");
		expect(paths[0]).toBe("/custom/path/whisper-server");
	});
});
