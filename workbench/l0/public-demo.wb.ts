import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
	PUBLIC_DEMO_DIR,
	publicDemoCursorReader,
	publicDemoDocument,
	publicDemoSamples,
} from "../lib/public-demo";
import { PUBLIC_DEMO_SCENARIOS, PUBLIC_DEMO_TRUTH } from "../scenarios/public-demo.scn";

it("loads a fresh portable project with actual media and no invented transcript", () => {
	const doc = publicDemoDocument();
	expect(doc.assets[0].durationSec).toBe(15.966392);
	expect(doc.assets[0].originalPath).toBe(`${PUBLIC_DEMO_DIR}/demo.webm`);
	expect(readFileSync(doc.assets[0].originalPath).length).toBe(219456);
	expect(doc.transcripts).toEqual([]);
	expect(publicDemoDocument()).not.toBe(doc);
	const samples = publicDemoSamples();
	expect(samples).toHaveLength(402);
	expect(samples.filter((s) => s.interactionType === "click")).toHaveLength(2);
	for (const sample of samples) {
		expect(sample.timeMs).toBeGreaterThanOrEqual(0);
		expect(sample.timeMs).toBeLessThanOrEqual(16050);
		expect(sample.cx).toBeGreaterThanOrEqual(0);
		expect(sample.cx).toBeLessThanOrEqual(1);
	}
});
it("keeps labels and assertion metadata out of prompts, document and raw telemetry", () => {
	for (const scenario of PUBLIC_DEMO_SCENARIOS) {
		const inputs = JSON.stringify({
			prompt: scenario.prompt,
			document: scenario.document(),
			samples: publicDemoSamples(),
		});
		for (const zone of PUBLIC_DEMO_TRUTH) {
			expect(inputs).not.toContain(zone.label);
			expect(scenario.prompt).not.toContain(`${zone.startSec}`);
			expect(scenario.prompt).not.toContain(`${zone.endSec}`);
		}
		const document = scenario.document();
		expect(document.zoomRanges).toEqual([]);
		expect(document.annotations).toEqual([]);
		expect(document.timeline.trimRanges).toEqual([]);
		expect(inputs).not.toContain("PUBLIC_DEMO_TRUTH");
	}
});
it("loads the committed samples through the production sidecar parser", async () => {
	const reader = publicDemoCursorReader();
	const data = await reader.read({
		assetId: "asset_1",
		originalPath: `${PUBLIC_DEMO_DIR}/demo.webm`,
	});
	expect(data.status).toBe("ok");
	if (data.status === "ok")
		expect(
			data.samples.map((s) => ({
				timeMs: s.timeMs,
				cx: s.cx,
				cy: s.cy,
				interactionType: s.interactionType,
			})),
		).toEqual(
			publicDemoSamples().map((s) => ({
				timeMs: s.timeMs,
				cx: s.cx,
				cy: s.cy,
				interactionType: s.interactionType,
			})),
		);
});
