// Diagnostic: open the editor with a seeded project and dump the
// accessibility tree. Used to figure out the right selectors for
// chat input, help button, and timeline ruler — selectors I can't
// guess from the source alone.
import { expect, test } from "@playwright/test";

const EDITOR_URL = "http://localhost:5173/?windowType=editor";

const DOC = {
	schemaVersion: 3,
	project: {
		id: "proj_diag",
		title: "Diagnostic",
		createdAt: "2026-07-01T00:00:00.000Z",
		updatedAt: "2026-07-01T00:00:00.000Z",
	},
	assets: [
		{
			id: "asset_diag",
			kind: "video",
			label: "diagnostic.mp4",
			originalPath: "C:\\Users\\test\\recordings\\diagnostic.mp4",
			durationSec: 600,
			sizeBytes: 12_345_678,
			video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
		},
	],
	transcripts: [],
	timeline: {
		clips: [
			{
				id: "clip_diag",
				assetId: "asset_diag",
				sourceStartSec: 0,
				sourceEndSec: 600,
				timelineStartSec: 0,
				timelineEndSec: 600,
				wordRefs: [],
				origin: "system",
				reason: "",
			},
		],
		gaps: [],
		skipRanges: [],
		muteRanges: [],
		speedRanges: [],
		captionRanges: [],
	},
	annotations: [],
	zoomRanges: [
		{ id: "z1", startMs: 5_000, endMs: 15_000, level: 1.5 },
		{ id: "z2", startMs: 30_000, endMs: 45_000, level: 1.5 },
	],
	legacyEditor: null,
	agent: { pendingQuestions: [], suggestions: [], lastAppliedOperations: [] },
	preview: { strategy: "seek", revision: 0 },
	export: { preset: "final-balanced", lastJobId: null },
	history: { revisions: [] },
};

test("diagnostic: dump editor DOM + accessibility tree", async ({ page }) => {
	await page.addInitScript((serialized) => {
		localStorage.setItem("browser-shim-document", serialized);
	}, JSON.stringify(DOC));
	await page.goto(EDITOR_URL, { waitUntil: "domcontentloaded" });
	await page.getByTestId("timeline-pane").waitFor({ state: "visible" });
	await page.screenshot({ path: "test-results/diagnostic.png", fullPage: true });

	// Buttons in the right pane header.
	const helpButtons = await page.getByRole("button", { name: /help/i }).count();
	console.log(`[diag] help buttons found via getByRole('button', {name: /help/i}): ${helpButtons}`);

	const allButtons = await page.locator("button").count();
	console.log(`[diag] total <button> elements: ${allButtons}`);

	// What does the data-testid="preview" look like?
	const preview = page.getByTestId("preview");
	console.log(`[diag] preview visible: ${await preview.isVisible()}`);
	console.log(`[diag] preview html start: ${(await preview.innerHTML()).slice(0, 300)}`);

	// Look for the chat input. Try several selectors.
	for (const sel of [
		"textarea",
		'input[type="text"]',
		'[contenteditable="true"]',
		'[role="textbox"]',
		'[data-testid*="chat" i]',
	]) {
		const n = await page.locator(sel).count();
		console.log(`[diag] ${sel} count: ${n}`);
	}

	// Look for the right pane container.
	const rightPane = page
		.locator('[data-testid*="right" i], [class*="rightPane" i], [class*="RightPane" i]')
		.first();
	console.log(`[diag] rightPane exists: ${(await rightPane.count()) > 0}`);

	// Dump the first 1500 chars of the page HTML so we can see structure.
	const html = await page.content();
	console.log(`[diag] page html length: ${html.length}`);
	console.log(`[diag] first 1500 chars: ${html.slice(0, 1500)}`);

	// Force the test to pass (we're just printing diagnostics).
	expect(true).toBe(true);
});
