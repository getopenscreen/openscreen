import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

import type { SttBackend } from "./transcriptionContract";

/**
 * Picks the `whisper-server` binary variant for the current host. The spec
 * locks no user-visible toggle — backend selection is automatic from platform +
 * GPU probes.
 *
 * Order of preference (highest first, falls through on probe failure):
 *   1. Apple Silicon                  → `whisper-metal`
 *   2. Apple Intel                    → `whisper-cpu`
 *   3. Linux/Windows + NVIDIA         → `whisper-cuda`
 *   4. Linux/Windows + Vulkan         → `whisper-vulkan`
 *   5. otherwise                      → `whisper-cpu`
 */

export interface GpuProbeResult {
	backend: SttBackend;
	/** Coarse reason for logs (e.g. "nvidia-smi exit 0", "darwin + arm64 → metal"). */
	reason: string;
}

/** Resolved locations for the `whisper-server` binary on disk; null until probes complete. */
export interface ResolvedBinary {
	backend: SttBackend;
	path: string | null;
}

/** Spawn with a hard deadline; resolves to `{exitCode}` or `null` (still running). */
function runProbe(
	cmd: string,
	args: string[],
	timeoutMs = 1500,
): Promise<{ exitCode: number | null }> {
	return new Promise((resolve) => {
		let settled = false;
		const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "ignore"] });
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill();
			resolve({ exitCode: null });
		}, timeoutMs);
		child.once("error", () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ exitCode: null });
		});
		child.once("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ exitCode: code });
		});
	});
}

/** `nvidia-smi` returning an exit code (any version) is a positive NVIDIA signal. */
async function probeNvidia(): Promise<boolean> {
	const result = await runProbe("nvidia-smi", ["-L"]);
	return result.exitCode === 0;
}

/** Vulkan loader present (libvulkan / vulkan-1.dll).  */
async function probeVulkan(): Promise<boolean> {
	if (process.platform === "win32") {
		return runProbe("where", ["vulkaninfo"]).then((r) => r.exitCode === 0);
	}
	if (process.platform === "darwin") {
		return runProbe("which", ["vulkaninfo"]).then((r) => r.exitCode === 0);
	}
	// Linux: try ldconfig for libvulkan.so.1, the canonical name.
	return runProbe("sh", ["-c", "ldconfig -p | grep -q libvulkan.so.1"]).then(
		(r) => r.exitCode === 0,
	);
}

/** Apple Silicon / Intel. darwin/arm64 → metal; darwin/x64 → cpu. */
function darwinBackend(): GpuProbeResult {
	const arm = process.arch === "arm64" || os.arch() === "arm64";
	return {
		backend: arm ? "whisper-metal" : "whisper-cpu",
		reason: `darwin + ${arm ? "arm64 → metal" : "x64 → cpu"}`,
	};
}

/**
 * Probe the host for GPU acceleration. Returns the chosen `SttBackend` plus a
 * short reason for log lines. Cheap to call: all probes run with a hard
 * timeout and the worst total wait is ~3s (nvidia + vulkan probes sequenced).
 *
 * ponytail: the binary's `candidateBinaryPaths` is consulted before claiming
 * a backend is available. The user might have an NVIDIA driver installed but
 * not the matching whisper-server CUDA binary (build is 30+ min + CUDA SDK);
 * in that case we drop to CPU rather than failing at spawn time.
 */
export async function detectGpuBackend(): Promise<GpuProbeResult> {
	if (process.platform === "darwin") {
		return darwinBackend();
	}

	if ((await probeNvidia()) && binaryAvailable("whisper-cuda", process.cwd())) {
		return { backend: "whisper-cuda", reason: "nvidia-smi present + binary built → cuda" };
	}

	if ((await probeVulkan()) && binaryAvailable("whisper-vulkan", process.cwd())) {
		return { backend: "whisper-vulkan", reason: "vulkan loader present + binary built → vulkan" };
	}

	return { backend: "whisper-cpu", reason: "no usable GPU backend → cpu" };
}

/** True if at least one of the candidate paths for this backend exists on disk. */
function binaryAvailable(backend: SttBackend, here: string): boolean {
	const paths = candidateBinaryPaths(backend, here);
	return paths.some((p) => {
		try {
			return require("node:fs").existsSync(p);
		} catch {
			return false;
		}
	});
}

/** Conventional bin name for the chosen backend; matches `build-whisper-binaries.sh`.
 * Includes the `.exe` suffix on Windows so the OS can execute the file — without
 * it, `fs.access(X_OK)` reports "not executable" because Win32's spawn shell
 * can't resolve a bare name to an executable image. */
export function binaryNameForBackend(backend: SttBackend): string {
	const suffix = process.platform === "win32" ? ".exe" : "";
	return `whisper-server-${backend}${suffix}`;
}

/**
 * Where to look for the binary, in priority order:
 *   1. `OPENSCREEN_WHISPER_SERVER_EXE` env override (debug builds)
 *   2. `electron/native/bin/<os>-<arch>/<binaryName>` (packaged + local cross-builds)
 *   3. `electron/native/bin/<binaryName>` (bare checkout, e.g. tests)
 *
 * ponytail: on Windows, accept both the .exe-suffixed and bare names so a
 * checkout that pre-dates the suffix fix still resolves to a valid file.
 */
export function candidateBinaryPaths(backend: SttBackend, here: string = process.cwd()): string[] {
	const tag = `${process.platform}-${process.arch}`;
	const name = binaryNameForBackend(backend);
	const envPath = process.env.OPENSCREEN_WHISPER_SERVER_EXE?.trim();
	const names = name.endsWith(".exe") ? [name, name.replace(/\.exe$/, "")] : [name];
	return [
		...names.map((n) => (envPath ? envPath : n)),
		...names.map((n) => path.join(here, "electron", "native", "bin", tag, n)),
		...names.map((n) => path.join(here, "electron", "native", "bin", n)),
	].filter((p): p is string => Boolean(p));
}

/** Probe → first existing candidate → null if none.
 *
 * ponytail: `resolveBinaryPath` verifies each candidate via `existsSync` (sync
 * filesystem probe, no I/O stall). The earlier "return the first string" was
 * shipping the bare `OPENSCREEN_WHISPER_SERVER_EXE` style path when no env
 * override is set, which is a bare filename that doesn't resolve — causing
 * "is not executable" downstream. Real check, not string-only. */
export async function resolveBinaryPath(here: string = process.cwd()): Promise<ResolvedBinary> {
	const { existsSync } = await import("node:fs");
	const probe = await detectGpuBackend();
	for (const candidate of candidateBinaryPaths(probe.backend, here)) {
		if (candidate && existsSync(candidate)) {
			return { backend: probe.backend, path: candidate };
		}
	}
	return { backend: probe.backend, path: null };
}
