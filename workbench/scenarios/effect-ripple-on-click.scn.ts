// ponytail: the first scenario of agent-written shader effects (docs/shader-effects.md, E.7).
// The prompt names a visual effect no setting offers, so the one right move is to WRITE one:
// addEffect, with WGSL whose wave starts from `ctx.clicks`, over a region that covers the clicks.
// The effect does not need the cursor track: the compositor hands it every click already placed
// in output uv (contract C.2). Reading the track is therefore neither required nor penalised.
//
// Offline there is no compositor: the code is not compiled, the result says `validated: false`,
// and the checks read the code as text. A live run inside the app compiles it for real.

import { cursorTelemetry, singleClip } from "../lib/fixtures";
import { defineScenario, fail, pass } from "../lib/scenario";

/** Three clicks, one per dwell, at its middle: 3 s, 9 s and 17 s. */
const DWELLS = [
	{ atSec: 3, holdSec: 1.2, cx: 0.3, cy: 0.4 },
	{ atSec: 9, holdSec: 1, cx: 0.72, cy: 0.55 },
	{ atSec: 17, holdSec: 0.9, cx: 0.5, cy: 0.8 },
];
const DURATION_SEC = 24.703979;
/** How long after a click its ripple must still be inside a region. */
const RIPPLE_SEC = 0.5;

const RIPPLE = [
	"fn ripple(uv: vec2<f32>, click: vec4<f32>) -> vec2<f32> {",
	"    if (click.w < 0.5 || click.z > params.duration) { return vec2<f32>(0.0); }",
	"    let t = click.z / params.duration;",
	"    let d = (uv - click.xy) * vec2<f32>(ctx.aspect, 1.0);",
	"    let r = length(d);",
	"    let x = params.radius * (1.0 - pow(1.0 - t, 3.0)) - r;",
	"    let env = smoothstep(-0.008, 0.0, x) * exp(-max(x, 0.0) / 0.07);",
	"    let wave = sin(x / 0.03 * 6.2831853) * env * (1.0 - t) * (1.0 - t);",
	"    let dir = select(vec2<f32>(0.0), d / r, r > 1e-5);",
	"    return dir * wave * 0.01 / vec2<f32>(ctx.aspect, 1.0);",
	"}",
	"fn effect(uv: vec2<f32>) -> vec4<f32> {",
	"    var offset = vec2<f32>(0.0);",
	"    for (var i = 0; i < 4; i++) { offset += ripple(uv, ctx.clicks[i]); }",
	"    return frame(uv - offset);",
	"}",
].join("\n");

export default defineScenario({
	id: "effect-ripple-on-click",
	title: "Effet shader — un ripple à chaque clic de souris",
	tags: ["effects", "dsl"],
	prompt: "Add a ripple effect on every mouse click.",
	document: () => singleClip(),
	cursorTelemetry: () => cursorTelemetry({ dwells: DWELLS, durationSec: DURATION_SEC }),
	gate: 0.6,
	reps: 3,

	behaviour: [
		{
			id: "beh.writes-an-effect",
			weight: 3,
			check: (c) =>
				c.calls("addEffect").length > 0
					? pass()
					: fail("aucun addEffect : aucun réglage ne fait de ripple, il fallait l'écrire"),
		},
	],

	dsl: [
		{
			id: "dsl.effect.reads-the-clicks",
			weight: 3,
			check: (c) =>
				(c.after.shaderEffects ?? []).some((e) => e.code.includes("ctx.clicks"))
					? pass()
					: fail("aucun effet ne lit ctx.clicks : l'onde ne peut pas partir du point du clic"),
		},
		{
			id: "dsl.effect.covers-the-clicks",
			weight: 3,
			check: (c) => {
				// Only a range of an effect that reads the clicks makes a ripple there.
				const readsClicks = new Set(
					(c.after.shaderEffects ?? [])
						.filter((e) => e.code.includes("ctx.clicks"))
						.map((e) => e.id),
				);
				const ranges = (c.after.shaderEffectRanges ?? []).filter((r) =>
					readsClicks.has(r.effectId),
				);
				const missed = DWELLS.filter(
					(d) =>
						!ranges.some(
							(r) => r.startMs <= d.atSec * 1000 && r.endMs >= (d.atSec + RIPPLE_SEC) * 1000,
						),
				);
				return missed.length === 0
					? pass()
					: fail(
							`clics hors de toute région d'un effet qui lit ctx.clicks : ${missed.map((d) => `${d.atSec} s`).join(", ")}`,
						);
			},
		},
		{
			id: "dsl.effect.image-by-default",
			weight: 2,
			check: (c) => {
				const elsewhere = (c.after.shaderEffectRanges ?? []).filter((r) => r.target !== "image");
				return elsewhere.length === 0
					? pass()
					: fail(`cible ${elsewhere[0].target} alors que rien ne demandait les textes`);
			},
		},
		{
			id: "dsl.turn.completed",
			weight: 2,
			check: (c) =>
				c.run.ok ? pass() : fail(`${c.classifyFailure()} : ${(c.run.error ?? "").slice(0, 200)}`),
		},
	],

	demoScript: [
		{ kind: "tools", calls: [{ name: "getCurrentDocument", args: {} }] },
		{
			kind: "tools",
			calls: [
				{
					name: "addEffect",
					args: {
						startSec: 0,
						endSec: DURATION_SEC,
						effect: {
							name: "Ripple on click",
							description: "A water ripple spreads from every click and bends the picture.",
							code: RIPPLE,
							params: [
								{
									type: "number",
									name: "radius",
									label: "Radius",
									default: 0.2,
									min: 0.05,
									max: 0.5,
								},
								{
									type: "number",
									name: "duration",
									label: "Duration",
									default: 0.9,
									min: 0.3,
									max: 2,
								},
							],
						},
					},
				},
			],
		},
		{
			kind: "text",
			text: "I added a ripple that spreads from every click, across the whole video.",
		},
	],
});
