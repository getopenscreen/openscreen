import { expect, it } from "vitest";
import { runRepetition } from "../lib/runner";
import type { Scenario } from "../lib/scenario";
import {
	PUBLIC_DEMO_SCENARIOS,
	PUBLIC_DEMO_TRUTH,
	publicDemoEnhance,
	publicDemoGrounding,
	publicDemoZooms,
} from "../scenarios/public-demo.scn";

async function failures(scenario: Scenario) {
	const result = await runRepetition({ scenario });
	expect(result.run.ok, result.run.error).toBe(true);
	return [...result.scored.dsl.results, ...result.scored.behaviour.results]
		.filter((c) => !c.ok && !c.indeterminate)
		.map((c) => c.id);
}
it("batch trims retain enhancement scope without allowing cuts through activity", async () => {
	const script = publicDemoEnhance.demoScript!;
	for (const [startSec, endSec, damaged] of [
		[0.1, 0.5, false],
		[8, 9, true],
	] as const) {
		const bad = await failures({
			...publicDemoEnhance,
			demoScript: [
				script[0],
				script[1],
				script[2],
				{
					kind: "tools",
					calls: [{ name: "addTrims", args: { ranges: [{ startSec, endSec }] } }],
				},
				script[3],
			],
		});
		expect(bad).not.toContain("dsl.scope");
		expect(bad.includes("dsl.activity.intact")).toBe(damaged);
	}
});
it("batch zoom tools stay within the same editing scope as individual zooms", async () => {
	for (const scenario of PUBLIC_DEMO_SCENARIOS) {
		const script = scenario.demoScript!;
		const zooms = script[2];
		if (zooms.kind !== "tools") throw new Error("Expected zoom calls");
		expect(
			await failures({
				...scenario,
				demoScript: [
					script[0],
					script[1],
					{
						kind: "tools",
						calls: [{ name: "addZooms", args: { regions: zooms.calls.map((call) => call.args) } }],
					},
					script[3],
				],
			}),
		).toEqual([]);
	}
});
it("scripts exercise the checks; judged evidence stays unmeasured offline", async () => {
	for (const scenario of PUBLIC_DEMO_SCENARIOS) {
		expect(await failures(scenario), scenario.id).toEqual([]);
		const result = await runRepetition({ scenario });
		expect(
			result.scored.behaviour.results.find((c) => c.id === "beh.attributes-the-limit")
				?.indeterminate,
		).toBe(true);
		const sent = JSON.stringify(result.run.requests.map((r) => r.raw));
		expect(sent).toContain("getCursorTrack");
		for (const zone of PUBLIC_DEMO_TRUTH) expect(sent).not.toContain(zone.label);
	}
});
it("the wire audit detects an intentionally leaked annotation", async () => {
	const result = await runRepetition({
		scenario: {
			...publicDemoZooms,
			prompt: `${publicDemoZooms.prompt} ${PUBLIC_DEMO_TRUTH[1].label}`,
		},
	});
	expect(JSON.stringify(result.run.requests.map((r) => r.raw))).toContain(
		PUBLIC_DEMO_TRUTH[1].label,
	);
});
it("empty edits fail placement, recall, focus and telemetry", async () => {
	const bad = await failures({
		...publicDemoGrounding,
		demoScript: [{ kind: "text", text: "Done" }],
	});
	for (const id of [
		"dsl.zoom.precision",
		"dsl.zoom.recall",
		"dsl.zoom.sweep-focus",
		"dsl.consults.telemetry",
		"dsl.consults.before-editing",
	])
		expect(bad).toContain(id);
});
it("reading after editing fails grounding, even with correct zoom placement", async () => {
	const script = publicDemoGrounding.demoScript!;
	const bad = await failures({
		...publicDemoGrounding,
		demoScript: [script[0], script[2], script[1], script[3]],
	});
	expect(bad).toContain("dsl.consults.before-editing");
	expect(bad).not.toContain("dsl.zoom.recall");
});
it("a successful tool name without available data does not count as grounding", async () => {
	const bad = await failures({
		...publicDemoGrounding,
		demoScript: [
			{ kind: "tools", calls: [{ name: "getCursorTrack", args: { assetId: "missing" } }] },
			{ kind: "text", text: "Done" },
		],
	});
	expect(bad).toContain("dsl.consults.telemetry");
});
it("a wrong spatial focus and an unrelated trim are both detected", async () => {
	const bad = await failures({
		...publicDemoZooms,
		demoScript: [
			{ kind: "tools", calls: [{ name: "getCurrentDocument", args: {} }] },
			{
				kind: "tools",
				calls: [
					{
						name: "addZoom",
						args: { startSec: 7.2, endSec: 10.8, depth: 2, focus: { cx: 0.1, cy: 0.1 } },
					},
					{ name: "addTrim", args: { startSec: 0, endSec: 1 } },
				],
			},
			{ kind: "text", text: "Done" },
		],
	});
	expect(bad).toContain("dsl.zoom.sweep-focus");
	expect(bad).toContain("dsl.scope");
});

it("correct timing with wrong preview/selection focus fails spatial placement", async () => {
	const bad = await failures({
		...publicDemoZooms,
		demoScript: [
			{ kind: "tools", calls: [{ name: "getCurrentDocument", args: {} }] },
			{
				kind: "tools",
				calls: [
					{
						name: "addZoom",
						args: { startSec: 2, endSec: 4.6, depth: 2, focus: { cx: 0.9, cy: 0.1 } },
					},
					{
						name: "addZoom",
						args: { startSec: 13.2, endSec: 14.8, depth: 2, focus: { cx: 0.1, cy: 0.9 } },
					},
				],
			},
			{ kind: "text", text: "Done" },
		],
	});
	expect(bad).toContain("dsl.zoom.spatial-placement");
	expect(bad).not.toContain("dsl.zoom.recall");
});

it("enhancement cannot hide a cut through the visible sweep", async () => {
	const scenario = PUBLIC_DEMO_SCENARIOS[0];
	const bad = await failures({
		...scenario,
		demoScript: [
			...scenario.demoScript!.slice(0, -1),
			{ kind: "tools", calls: [{ name: "addTrim", args: { startSec: 8, endSec: 10 } }] },
			{ kind: "text", text: "Done" },
		],
	});
	expect(bad).toContain("dsl.activity.intact");
});

it("40-49 percent temporal coverage cannot bypass spatial grounding", async () => {
	const bad = await failures({
		...publicDemoZooms,
		demoScript: [
			{ kind: "tools", calls: [{ name: "getCurrentDocument", args: {} }] },
			{
				kind: "tools",
				calls: [
					{
						name: "addZoom",
						args: { startSec: 2, endSec: 3.4, depth: 2, focus: { cx: 0.9, cy: 0.1 } },
					},
					{
						name: "addZoom",
						args: { startSec: 7.2, endSec: 10.8, depth: 2, focus: { cx: 0.66, cy: 0.6 } },
					},
				],
			},
			{ kind: "text", text: "Done" },
		],
	});
	expect(bad).toContain("dsl.zoom.spatial-placement");
	expect(bad).not.toContain("dsl.zoom.recall");
});

it("a read and mutation in the same parallel batch is not evidence of prior grounding", async () => {
	const script = publicDemoGrounding.demoScript!;
	const bad = await failures({
		...publicDemoGrounding,
		demoScript: [
			script[0],
			{
				kind: "tools",
				calls: [
					{ name: "getCursorTrack", args: {} },
					...(script[2].kind === "tools" ? script[2].calls : []),
				],
			},
			script[3],
		],
	});
	expect(bad).toContain("dsl.consults.before-editing");
});
