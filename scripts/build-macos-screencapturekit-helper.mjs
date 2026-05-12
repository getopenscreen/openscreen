#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
	console.log("Skipping macOS ScreenCaptureKit helper build: host platform is not macOS.");
	process.exit(0);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const helperName = "openscreen-screencapturekit-helper";
const cursorHelperName = "openscreen-macos-cursor-helper";
const packageDir = path.join(root, "electron", "native", "screencapturekit");
const buildDir = path.join(packageDir, "build");
const swiftBuildDir = path.join(buildDir, "swiftpm");
const builtHelperPath = path.join(swiftBuildDir, "release", helperName);
const localHelperPath = path.join(buildDir, helperName);
const builtCursorHelperPath = path.join(swiftBuildDir, "release", cursorHelperName);
const localCursorHelperPath = path.join(buildDir, cursorHelperName);
const archTag = process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
const distributableDir = path.join(root, "electron", "native", "bin", archTag);
const distributablePath = path.join(distributableDir, helperName);
const distributableCursorHelperPath = path.join(distributableDir, cursorHelperName);

const xcodebuildVersion = spawnSync("xcodebuild", ["-version"], {
	cwd: root,
	encoding: "utf8",
});

if (xcodebuildVersion.status !== 0) {
	const message = `${xcodebuildVersion.stderr ?? ""}${xcodebuildVersion.stdout ?? ""}`.trim();
	console.error(
		[
			"Unable to build the macOS ScreenCaptureKit helper because full Xcode is not active.",
			"",
			message,
			"",
			"Install Xcode from the App Store or Apple Developer downloads, then run:",
			"  sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer",
			"  sudo xcodebuild -license accept",
			"",
			"Command Line Tools alone may not include the Swift SDK/platform metadata required by SwiftPM.",
		].join("\n"),
	);
	process.exit(1);
}

const result = spawnSync(
	"swift",
	["build", "-c", "release", "--package-path", packageDir, "--build-path", swiftBuildDir],
	{
		cwd: root,
		stdio: "inherit",
	},
);

if (result.error) {
	console.error(`Failed to start Swift build: ${result.error.message}`);
	process.exit(1);
}

if (result.status !== 0) {
	process.exit(result.status ?? 1);
}

fs.mkdirSync(buildDir, { recursive: true });
fs.mkdirSync(distributableDir, { recursive: true });
fs.copyFileSync(builtHelperPath, localHelperPath);
fs.copyFileSync(builtHelperPath, distributablePath);
fs.copyFileSync(builtCursorHelperPath, localCursorHelperPath);
fs.copyFileSync(builtCursorHelperPath, distributableCursorHelperPath);
fs.chmodSync(localHelperPath, 0o755);
fs.chmodSync(distributablePath, 0o755);
fs.chmodSync(localCursorHelperPath, 0o755);
fs.chmodSync(distributableCursorHelperPath, 0o755);

console.log(`Built macOS ScreenCaptureKit helper: ${localHelperPath}`);
console.log(`Copied redistributable helper: ${distributablePath}`);
console.log(`Built macOS cursor helper: ${localCursorHelperPath}`);
console.log(`Copied redistributable cursor helper: ${distributableCursorHelperPath}`);
