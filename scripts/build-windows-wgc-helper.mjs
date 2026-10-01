import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findVcVarsAll, run as spawnStep } from "./msvcEnv.mjs";

import {
	parseArchFlag,
	resolveTargetArch,
	resolveVcvarsArch,
	winBinDirName,
} from "./windows-helper-arch.mjs";

const TARGET_ARCH = resolveTargetArch({
	cliArch: parseArchFlag(process.argv.slice(2)),
	envArch: process.env.OPENSCREEN_WIN_HELPER_ARCH,
	hostArch: process.arch,
});
const VCVARS_ARCH = resolveVcvarsArch(process.arch, TARGET_ARCH);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const SOURCE_DIR = path.join(ROOT, "electron", "native", "wgc-capture");
const BUILD_DIR = path.join(SOURCE_DIR, "build");
const COMPAT_LIB_DIR = path.join(BUILD_DIR, "compat-libs");
const BIN_DIR = path.join(ROOT, "electron", "native", "bin", winBinDirName(TARGET_ARCH));
const CMAKE = process.env.CMAKE_EXE ?? "cmake";

function findWindowsSdkUmLibDir() {
	const sdkLibRoot = "C:\\Program Files (x86)\\Windows Kits\\10\\Lib";
	if (!fs.existsSync(sdkLibRoot)) {
		return null;
	}

	return fs
		.readdirSync(sdkLibRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => path.join(sdkLibRoot, entry.name, "um", TARGET_ARCH))
		.filter((candidate) => fs.existsSync(path.join(candidate, "kernel32.lib")))
		.sort()
		.at(-1);
}

const run = (command, args, options = {}) => spawnStep(command, args, { cwd: ROOT, ...options });

async function runInVsEnv(command) {
	const vcvarsAll = findVcVarsAll();
	if (!vcvarsAll) {
		throw new Error(
			"Could not find Visual Studio vcvarsall.bat. Install Visual Studio Build Tools with C++.",
		);
	}

	const sdkUmLibDir = findWindowsSdkUmLibDir();

	const cmdPath = path.join(os.tmpdir(), `openscreen-build-wgc-${process.pid}-${Date.now()}.cmd`);
	fs.writeFileSync(
		cmdPath,
		[
			"@echo off",
			`call "${vcvarsAll}" ${VCVARS_ARCH}`,
			"if errorlevel 1 exit /b %errorlevel%",
			`if not exist "${COMPAT_LIB_DIR}" mkdir "${COMPAT_LIB_DIR}"`,
			`for %%L in (gdi32.lib gdiplus.lib winspool.lib shell32.lib oleaut32.lib uuid.lib comdlg32.lib advapi32.lib) do if not exist "%WindowsSdkDir%Lib\\%WindowsSDKLibVersion%um\\${TARGET_ARCH}\\%%L" copy /Y "%WindowsSdkDir%Lib\\%WindowsSDKLibVersion%um\\${TARGET_ARCH}\\kernel32.Lib" "${COMPAT_LIB_DIR}\\%%L" >nul`,
			"if errorlevel 1 exit /b %errorlevel%",
			`set "LIB=${sdkUmLibDir ? `${sdkUmLibDir};` : ""}%LIB%;${COMPAT_LIB_DIR}"`,
			command,
			"exit /b %errorlevel%",
			"",
		].join("\r\n"),
	);
	try {
		await run("cmd.exe", ["/d", "/c", cmdPath]);
	} finally {
		fs.rmSync(cmdPath, { force: true });
	}
}

if (process.platform !== "win32") {
	console.log("Skipping WGC helper build: Windows-only.");
	process.exit(0);
}

console.log(`Building Windows WGC helper for target arch: ${TARGET_ARCH} (vcvars: ${VCVARS_ARCH})`);

// CMake caches the detected compiler in the build directory. Reusing a build
// dir that was configured for a different target arch silently produces
// wrong-arch binaries (the cached compiler wins over the new vcvars env). Wipe
// the build dir when the target arch changes; same-arch reruns stay incremental.
const ARCH_STAMP = path.join(BUILD_DIR, ".target-arch");
if (fs.existsSync(BUILD_DIR)) {
	const previousArch = fs.existsSync(ARCH_STAMP)
		? fs.readFileSync(ARCH_STAMP, "utf8").trim()
		: "";
	if (previousArch !== TARGET_ARCH) {
		fs.rmSync(BUILD_DIR, { recursive: true, force: true });
	}
}
fs.mkdirSync(BUILD_DIR, { recursive: true });
fs.writeFileSync(ARCH_STAMP, TARGET_ARCH);

await runInVsEnv(
	`"${CMAKE}" -S "${SOURCE_DIR}" -B "${BUILD_DIR}" -G Ninja -DCMAKE_BUILD_TYPE=Release`,
);
await runInVsEnv(`"${CMAKE}" --build "${BUILD_DIR}" --config Release`);

const outputPath = path.join(BUILD_DIR, "wgc-capture.exe");
if (!fs.existsSync(outputPath)) {
	throw new Error(`WGC helper build completed but ${outputPath} was not found.`);
}

const cursorSamplerOutputPath = path.join(BUILD_DIR, "cursor-sampler.exe");
if (!fs.existsSync(cursorSamplerOutputPath)) {
	throw new Error(`WGC helper build completed but ${cursorSamplerOutputPath} was not found.`);
}

fs.mkdirSync(BIN_DIR, { recursive: true });
const distributablePath = path.join(BIN_DIR, "wgc-capture.exe");
fs.copyFileSync(outputPath, distributablePath);

const cursorSamplerDistributablePath = path.join(BIN_DIR, "cursor-sampler.exe");
fs.copyFileSync(cursorSamplerOutputPath, cursorSamplerDistributablePath);

console.log(`Built ${outputPath}`);
console.log(`Copied ${distributablePath}`);
console.log(`Built ${cursorSamplerOutputPath}`);
console.log(`Copied ${cursorSamplerDistributablePath}`);

const audioUtilsTestPath = path.join(BUILD_DIR, "audio_sample_utils_test.exe");
if (!fs.existsSync(audioUtilsTestPath)) {
	throw new Error(`WGC helper build completed but ${audioUtilsTestPath} was not found.`);
}
// Snap/resample unit tests must pass. Media Foundation AAC probes skip on
// hosts without the stock encoder (Windows N/KN, Server without Media Feature
// Pack) instead of failing this packaging command.
await run(audioUtilsTestPath, [], { cwd: BUILD_DIR });
console.log(`Passed ${audioUtilsTestPath}`);

const webcamFormatTestPath = path.join(BUILD_DIR, "webcam_format_test.exe");
if (!fs.existsSync(webcamFormatTestPath)) {
	throw new Error(`WGC helper build completed but ${webcamFormatTestPath} was not found.`);
}
// Guards the capture resolution the camera is driven at. Left unpinned, both
// backends fall back to the device default -- 640x480 on hardware that offers
// far more -- and the overlay upscales it.
await run(webcamFormatTestPath, [], { cwd: BUILD_DIR });
console.log(`Passed ${webcamFormatTestPath}`);

const frameVisibilityTestPath = path.join(BUILD_DIR, "frame_visibility_test.exe");
if (!fs.existsSync(frameVisibilityTestPath)) {
	throw new Error(`WGC helper build completed but ${frameVisibilityTestPath} was not found.`);
}
// Guards the warm-up probe that decides whether the camera has produced a
// picture yet. Studio-range black is 16, not 0, so an unnormalised average
// reads every black frame as content.
await run(frameVisibilityTestPath, [], { cwd: BUILD_DIR });
console.log(`Passed ${frameVisibilityTestPath}`);

const frameSlotClockTestPath = path.join(BUILD_DIR, "frame_slot_clock_test.exe");
if (!fs.existsSync(frameSlotClockTestPath)) {
	throw new Error(`WGC helper build completed but ${frameSlotClockTestPath} was not found.`);
}
// Guards the writer's cadence. The encoder numbers frames at the nominal rate,
// so a tick the writer misses must still be written or the video runs ahead
// of the audio for the rest of the take (#945).
await run(frameSlotClockTestPath, [], { cwd: BUILD_DIR });
console.log(`Passed ${frameSlotClockTestPath}`);

const webcamSnapshotTestPath = path.join(BUILD_DIR, "webcam_snapshot_test.exe");
if (!fs.existsSync(webcamSnapshotTestPath)) {
	throw new Error(`WGC helper build completed but ${webcamSnapshotTestPath} was not found.`);
}
// Guards the per-tick webcam poll. The writer asks at the screen's rate, twice
// the camera's, so a frame it already holds must not be copied again.
await run(webcamSnapshotTestPath, [], { cwd: BUILD_DIR });
console.log(`Passed ${webcamSnapshotTestPath}`);

const encoderColorTestPath = path.join(BUILD_DIR, "mf_encoder_color_test.exe");
if (!fs.existsSync(encoderColorTestPath)) {
	throw new Error(`WGC helper build completed but ${encoderColorTestPath} was not found.`);
}
// Guards what the H.264 track is and says: High profile, BT.709 studio range
// in the samples and in the tags, which is what the compositor decodes. Media
// Foundation's own colour converter wrote BT.601. Skips its file checks when
// ffprobe/ffmpeg are not on PATH.
await run(encoderColorTestPath, [], { cwd: BUILD_DIR });
console.log(`Passed ${encoderColorTestPath}`);
