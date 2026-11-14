import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { documentSchema, migrateRawDocumentToCurrent } from "../../src/lib/ai-edition/schema";
import type { CursorTrackSample } from "../../src/lib/ai-edition/timeline/cursor-track";
import { sidecarCursorReader } from "./harness";

export const PUBLIC_DEMO_DIR = "workbench/public-fixtures/local-demo-v1";
export const PUBLIC_DEMO_FILES = [
	"demo.webm",
	"demo.webm.cursor.json",
	"project.openscreen",
	"demo.html",
	"capture.mjs",
	"README.md",
] as const;
export function publicDemoDocument() {
	return documentSchema.parse(
		migrateRawDocumentToCurrent(
			JSON.parse(readFileSync(resolve(PUBLIC_DEMO_DIR, "project.openscreen"), "utf8")),
		),
	);
}
export function publicDemoSamples(): CursorTrackSample[] {
	return JSON.parse(readFileSync(resolve(PUBLIC_DEMO_DIR, "demo.webm.cursor.json"), "utf8"))
		.samples;
}
export function publicDemoCursorReader() {
	return sidecarCursorReader({ asset_1: resolve(PUBLIC_DEMO_DIR, "demo.webm") });
}
