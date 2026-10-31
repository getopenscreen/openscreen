// The annotations below are assertion inputs only. Neither the loader nor the
// demo script imports them. See the L1 wire audit and its deliberate leak control.

import { AI_ENHANCE_PROMPT } from "../lib/prompts";
import { publicDemoCursorReader, publicDemoDocument } from "../lib/public-demo";
import { zoomPlacement } from "../lib/quality";
import { NAMES_WHOSE_LIMIT, pointerReadFacts } from "../lib/rubrics";
import { type Check, defineScenario, fail, pass, undecided } from "../lib/scenario";
import { callsWithData } from "../lib/wire";

// Visual inspection of the committed recording, not inferred from a transcript.
export const PUBLIC_DEMO_TRUTH = [
	{ startSec: 1.8, endSec: 4.8, label: "annotation preview interaction", cx: 0.225, cy: 0.511 },
	{ startSec: 7, endSec: 11, label: "annotation continuous comparison sweep", cx: 0.663, cy: 0.6 },
	{ startSec: 13, endSec: 15, label: "annotation comparison-area click", cx: 0.813, cy: 0.4 },
];
// Coordinates are normalized: include the decimal boundary despite subtraction rounding.
const FOCUS_TOLERANCE = 0.15 + Number.EPSILON;
const readBeforeEdit: Check = {
	id: "beh.read-before-edit",
	weight: 2,
	check: (c) => {
		const reads = c.calls("getCurrentDocument").filter((call) => call.resultOk);
		return reads.length > 0 &&
			reads[0].round < (c.wire.calls.find((call) => call.mutating)?.round ?? Infinity)
			? pass()
			: fail("No successful project read before editing");
	},
};
const completed: Check = {
	id: "dsl.turn.completed",
	weight: 3,
	check: (c) => (c.run.ok ? pass() : fail(c.run.error ?? "Turn failed")),
};
const placement: Check[] = [
	{
		id: "dsl.zoom.precision",
		weight: 3,
		check: (c) => {
			const p = c.zoomPlacement(PUBLIC_DEMO_TRUTH);
			return p.hits.length > 0 && p.precision >= 0.6 ? pass() : fail(`precision ${p.precision}`);
		},
	},
	{
		id: "dsl.zoom.recall",
		weight: 3,
		check: (c) => {
			const p = c.zoomPlacement(PUBLIC_DEMO_TRUTH);
			return p.zones.filter((z) => z.covered).length >= 2
				? pass()
				: fail(`covered ${p.zones.filter((z) => z.covered).length}/3 zones`);
		},
	},
	{
		id: "dsl.zoom.sweep-focus",
		weight: 3,
		check: (c) => {
			const zone = PUBLIC_DEMO_TRUTH[1];
			const hits = c.after.zoomRanges.filter(
				(z) => z.startMs / 1000 <= zone.startSec + 1 && z.endMs / 1000 >= zone.endSec - 1,
			);
			if (
				hits.some(
					(z) =>
						z.focusMode !== "auto" &&
						Math.abs(z.focus.cx - zone.cx) <= FOCUS_TOLERANCE &&
						Math.abs(z.focus.cy - zone.cy) <= FOCUS_TOLERANCE,
				)
			)
				return pass();
			if (hits.some((z) => z.focusMode === "auto"))
				return undecided(
					"Auto focus requires rendered trajectory review; stored coordinates do not measure it",
				);
			return fail("Sweep missing or focus misses the compared shapes");
		},
	},
	{
		id: "dsl.zoom.hygiene",
		weight: 2,
		check: (c) => {
			const issues = c.zoomIssues();
			return issues.length === 0 ? pass() : fail(JSON.stringify(issues));
		},
	},
];
placement.push({
	id: "dsl.zoom.spatial-placement",
	weight: 3,
	check: (c) => {
		const covered = c.zoomPlacement(PUBLIC_DEMO_TRUTH).zones.filter((entry) => entry.covered);
		let autoUnmeasured = false;
		const wrong = covered
			.filter(({ zone }) => {
				const focus = PUBLIC_DEMO_TRUTH.find((entry) => entry.label === zone.label)!;
				const zoomRanges = c.after.zoomRanges.filter(
					(z) =>
						z.focusMode !== "auto" &&
						Math.abs(z.focus.cx - focus.cx) <= FOCUS_TOLERANCE &&
						Math.abs(z.focus.cy - focus.cy) <= FOCUS_TOLERANCE,
				);
				if (zoomPlacement({ ...c.after, zoomRanges }, [zone]).zones[0].covered) return false;
				const auto = c.after.zoomRanges.filter((z) => z.focusMode === "auto");
				if (
					zoomPlacement({ ...c.after, zoomRanges: [...zoomRanges, ...auto] }, [zone]).zones[0]
						.covered
				) {
					autoUnmeasured = true;
					return false;
				}
				return true;
			})
			.map((entry) => entry.zone);

		if (wrong.length > 0) return fail(`Wrong focus for ${wrong.map((z) => z.label).join(", ")}`);
		return autoUnmeasured
			? undecided(
					"Auto focus requires rendered trajectory review; stored coordinates do not measure it",
				)
			: pass();
	},
});
const grounding: Check[] = [
	{
		id: "dsl.consults.telemetry",
		weight: 3,
		check: (c) =>
			callsWithData(c.wire.calls, "getCursorTrack").length > 0
				? pass()
				: fail("No successful telemetry read"),
	},
	{
		id: "dsl.consults.before-editing",
		weight: 3,
		check: (c) => {
			const reads = callsWithData(c.wire.calls, "getCursorTrack");
			return reads.length > 0 &&
				reads[0].round < (c.wire.calls.find((call) => call.mutating)?.round ?? Infinity)
				? pass()
				: fail("Telemetry absent or read after editing");
		},
	},
];
const demoScript = [
	{ kind: "tools" as const, calls: [{ name: "getCurrentDocument", args: {} }] },
	{ kind: "tools" as const, calls: [{ name: "getCursorTrack", args: {} }] },
	{
		kind: "tools" as const,
		calls: [
			{
				name: "addZoom",
				args: { startSec: 2, endSec: 4.6, depth: 2, focus: { cx: 0.23, cy: 0.51 } },
			},
			{
				name: "addZoom",
				args: { startSec: 7.2, endSec: 10.8, depth: 2, focus: { cx: 0.66, cy: 0.6 } },
			},
			{
				name: "addZoom",
				args: { startSec: 13.2, endSec: 14.8, depth: 2, focus: { cx: 0.81, cy: 0.4 } },
			},
		],
	},
	{
		kind: "text" as const,
		text: "Added three zooms based on the available pointer track. Timing is unchanged.",
	},
];
function scenario(id: string, enhance: boolean, method: boolean) {
	return defineScenario({
		id,
		title: `Public local browser demo: ${id}`,
		tags: ["public-recorded", "editorial"],
		prompt: enhance
			? AI_ENHANCE_PROMPT
			: "Add zoom-ins to the important moments in this recording. Keep the timing unchanged.",
		document: publicDemoDocument,
		cursorReader: publicDemoCursorReader,
		gate: 0,
		reps: 3,
		behaviour: [readBeforeEdit],
		judged: [
			{
				id: "beh.attributes-the-limit",
				weight: 3,
				rubric: NAMES_WHOSE_LIMIT,
				facts: pointerReadFacts,
			},
		],
		dsl: [
			completed,
			{
				id: "dsl.activity.intact",
				weight: 3,
				check: (c) => {
					const damage = c.after.timeline.trimRanges.reduce(
						(sum, trim) =>
							sum +
							PUBLIC_DEMO_TRUTH.reduce(
								(n, zone) =>
									n +
									Math.max(
										0,
										Math.min(trim.endSec, zone.endSec) - Math.max(trim.startSec, zone.startSec),
									),
								0,
							),
						0,
					);
					return damage <= 0.04
						? pass()
						: fail(`Trims remove ${damage.toFixed(3)} seconds of visible interaction`);
				},
			},
			...placement,
			...(method ? grounding : []),
			{
				id: "dsl.scope",
				weight: 3,
				check: (c) => {
					const breaches = c.scopeBreaches(
						enhance
							? {
									families: ["zoom", "trim"],
									tools: [
										"addZoom",
										"addZooms",
										"addAutoZooms",
										"setZoom",
										"removeModifier",
										"addTrim",
										"addTrims",
										"setTrim",
										"removeTrim",
									],
								}
							: {
									families: ["zoom"],
									tools: ["addZoom", "addZooms", "addAutoZooms", "setZoom", "removeModifier"],
								},
					);
					return breaches.length === 0 ? pass() : fail(JSON.stringify(breaches));
				},
			},
		],
		demoScript,
	});
}
export const publicDemoEnhance = scenario("public-demo-enhance", true, false);
export const publicDemoZooms = scenario("public-demo-zooms", false, false);
export const publicDemoGrounding = scenario("public-demo-grounding", false, true);
export const PUBLIC_DEMO_SCENARIOS = [publicDemoEnhance, publicDemoZooms, publicDemoGrounding];
