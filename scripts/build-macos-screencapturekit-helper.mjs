#!/usr/bin/env node

import process from "node:process";

if (process.platform !== "darwin") {
	console.log("Skipping macOS ScreenCaptureKit helper build: host platform is not macOS.");
	process.exit(0);
}

console.error(
	"macOS ScreenCaptureKit helper sources are not implemented yet. See docs/engineering/macos-native-recorder-roadmap.md.",
);
process.exit(1);
