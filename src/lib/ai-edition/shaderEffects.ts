import type {
	AxcutDocument,
	AxcutShaderEffect,
	AxcutShaderEffectKeyframe,
	AxcutShaderEffectParam,
	AxcutShaderEffectRange,
	AxcutShaderEffectValue,
} from "./schema";

/**
 * Agent-written shader effects (docs/shader-effects.md): the pure helpers the agent tools, the
 * scene projection and the editor share. The WGSL itself is checked and compiled by the
 * compositor (`crates/compositor/src/shader_fx.rs`).
 */

/** The WGSL contract this build writes and draws. */
export const SHADER_EFFECT_CONTRACT = 1;

export type ShaderEffectTier = "light" | "medium" | "heavy" | "very-heavy";

/** What the compositor says of an effect's code (`checkShaderEffect` in the addon). */
export interface ShaderEffectCheck {
	error?: string | null;
	tier?: ShaderEffectTier | null;
	frameReads?: number | null;
	iterations?: number | null;
}

/** Asks the compositor about a code; `null` where nothing can answer (no addon, a test). A
 *  promise: the compositor compiles for real, which takes 120 ms and more on Metal, off the main
 *  thread. `image`: the effect carries an image, so its code may call `image()`. */
export type ShaderEffectChecker = (
	code: string,
	params: ReadonlyArray<Pick<AxcutShaderEffectParam, "name" | "type">>,
	image: boolean,
) => Promise<ShaderEffectCheck | null>;

/** The checker's answer as the tool executor reads it, synchronously: `runDocumentTool` asked
 *  first (`shaderEffectToCheck`). `null` for a code that was not asked about. */
export type ShaderEffectCheckLookup = (
	code: string,
	params: ReadonlyArray<Pick<AxcutShaderEffectParam, "name" | "type">>,
	image: boolean,
) => ShaderEffectCheck | null;

/** The image an effect reads, as the document holds it. */
export type ShaderEffectImage = NonNullable<AxcutShaderEffect["image"]>;

/** Copies an image file an effect will read into the project's own folder (`effectImage.ts`),
 *  and rejects with what to tell the agent when the file is no image OpenScreen takes. */
export type ShaderEffectImageStore = (sourcePath: string) => Promise<ShaderEffectImage>;

/** What became of the image file a tool call attaches: OpenScreen's copy of it, or why there is
 *  none. `runDocumentTool` stores the file first (`effectImageToStore`); the executor reads this. */
export type ShaderEffectImageStored = { source: string } & (
	| { image: ShaderEffectImage }
	| { error: string }
);

export function findShaderEffect(
	document: AxcutDocument,
	effectId: string,
): AxcutShaderEffect | undefined {
	return (document.shaderEffects ?? []).find((effect) => effect.id === effectId);
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const isColor = (value: unknown): value is string =>
	typeof value === "string" && /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value);
const isPoint = (value: unknown): value is { x: number; y: number } =>
	typeof value === "object" &&
	value !== null &&
	Number.isFinite((value as { x?: unknown }).x) &&
	Number.isFinite((value as { y?: unknown }).y);

/** The value a parameter takes: `value` when it has the right type, clamped to the bounds, the
 *  default otherwise. */
export function resolveShaderEffectValue(
	param: AxcutShaderEffectParam,
	value: unknown,
): AxcutShaderEffectValue {
	switch (param.type) {
		case "number":
			return typeof value === "number" && Number.isFinite(value)
				? clamp(value, param.min, param.max)
				: param.default;
		case "toggle":
			return typeof value === "boolean" ? value : param.default;
		case "color":
			return isColor(value) ? value : param.default;
		case "point":
			return isPoint(value) ? { x: clamp(value.x, 0, 1), y: clamp(value.y, 0, 1) } : param.default;
	}
}

const sameValue = (a: AxcutShaderEffectValue, b: AxcutShaderEffectValue) =>
	JSON.stringify(a) === JSON.stringify(b);

/** What a region stores: only the values that differ from the defaults, each resolved against
 *  its parameter. Names the definition does not declare are dropped. */
export function storedShaderEffectValues(
	effect: Pick<AxcutShaderEffect, "params">,
	values: Record<string, unknown>,
): Record<string, AxcutShaderEffectValue> {
	const stored: Record<string, AxcutShaderEffectValue> = {};
	for (const param of effect.params) {
		if (!(param.name in values)) continue;
		const value = resolveShaderEffectValue(param, values[param.name]);
		if (!sameValue(value, param.default)) stored[param.name] = value;
	}
	return stored;
}

const EXPECTED_VALUE: Record<AxcutShaderEffectParam["type"], string> = {
	number: "a number",
	toggle: "true or false",
	color: 'a color "#rrggbb" or "#rrggbbaa"',
	point: "a point { x, y }",
};

function fitsParam(param: AxcutShaderEffectParam, value: unknown): boolean {
	switch (param.type) {
		case "number":
			return typeof value === "number" && Number.isFinite(value);
		case "toggle":
			return typeof value === "boolean";
		case "color":
			return isColor(value);
		case "point":
			return isPoint(value);
	}
}

export type ShaderEffectAnimate = Record<string, AxcutShaderEffectKeyframe[]>;

/** What a region stores for `animate`: each track sorted by `atSec`, each value clamped like a
 *  plain value. An empty track is dropped; `undefined` when nothing is left animated. Refused
 *  with a message: a name the definition does not declare, a value of the wrong type. */
export function storedShaderEffectAnimate(
	effect: Pick<AxcutShaderEffect, "params">,
	animate: ShaderEffectAnimate,
): { animate: ShaderEffectAnimate | undefined } | { error: string } {
	const stored: ShaderEffectAnimate = {};
	for (const [name, track] of Object.entries(animate)) {
		const param = effect.params.find((p) => p.name === name);
		if (!param) {
			const declared = effect.params.map((p) => p.name).join(", ") || "none";
			return {
				error: `animate: "${name}" is not a parameter of this effect. Declared: ${declared}.`,
			};
		}
		for (const [index, keyframe] of track.entries()) {
			if (!fitsParam(param, keyframe.value)) {
				return {
					error: `animate.${name}[${index}]: the value must be ${EXPECTED_VALUE[param.type]}, the type of the ${param.type} parameter "${name}".`,
				};
			}
		}
		if (track.length === 0) continue;
		stored[name] = [...track]
			.sort((a, b) => a.atSec - b.atSec)
			.map((keyframe) => ({ ...keyframe, value: resolveShaderEffectValue(param, keyframe.value) }));
	}
	return { animate: Object.keys(stored).length > 0 ? stored : undefined };
}

/** `region` with `animate` set, or without the key at all when nothing is animated. */
export function withShaderEffectAnimate<T extends { animate?: ShaderEffectAnimate }>(
	region: T,
	animate: ShaderEffectAnimate | undefined,
): T {
	const { animate: _dropped, ...rest } = region;
	return (animate ? { ...rest, animate } : rest) as T;
}

/** A keyframe as the compositor samples it (`ShaderKeyframe` in `scene.rs`): the value packed
 *  like a plain one, and the curve to the next keyframe as a bezier, a spring bounce or a hold.
 *  Linear when none is set. */
export interface NativeShaderKeyframe {
	atSec: number;
	value: number | number[];
	bezier?: [number, number, number, number];
	spring?: number;
	hold?: true;
}

const NAMED_BEZIER: Record<string, [number, number, number, number]> = {
	linear: [0, 0, 1, 1],
	"ease-in": [0.42, 0, 1, 1],
	"ease-out": [0, 0, 0.58, 1],
	"ease-in-out": [0.42, 0, 0.58, 1],
};

/** A track as the compositor samples it, in time order: the compositor interpolates from each
 *  keyframe to the next in the list, and a document written by hand may list them in any order.
 *  A toggle always holds: it steps at each keyframe. */
export function nativeShaderEffectTrack(
	param: AxcutShaderEffectParam,
	track: AxcutShaderEffectKeyframe[],
): NativeShaderKeyframe[] {
	return [...track]
		.sort((a, b) => a.atSec - b.atSec)
		.map(({ atSec, value, ease }) => {
			const native = { atSec, value: nativeShaderEffectValue(param, value) };
			if (param.type === "toggle" || ease === "hold") return { ...native, hold: true };
			if (ease === undefined) return native;
			if (typeof ease === "string") return { ...native, bezier: NAMED_BEZIER[ease] };
			if (Array.isArray(ease)) return { ...native, bezier: ease };
			return { ...native, spring: ease.spring.bounce };
		});
}

function hexToRgba(hex: string): [number, number, number, number] {
	const channel = (i: number) => Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
	return [channel(0), channel(1), channel(2), hex.length === 9 ? channel(3) : 1];
}

/** A parameter's value as the compositor packs it: one float, or 2 (point) or 4 (color). */
export function nativeShaderEffectValue(
	param: AxcutShaderEffectParam,
	value: unknown,
): number | number[] {
	const resolved = resolveShaderEffectValue(param, value);
	switch (param.type) {
		case "number":
			return resolved as number;
		case "toggle":
			return resolved ? 1 : 0;
		case "color":
			return hexToRgba(resolved as string);
		case "point": {
			const { x, y } = resolved as { x: number; y: number };
			return [x, y];
		}
	}
}

/** The document without the definitions no region uses: no dead code is kept. */
export function pruneUnusedShaderEffects(document: AxcutDocument): AxcutDocument {
	const used = new Set((document.shaderEffectRanges ?? []).map((range) => range.effectId));
	if ((document.shaderEffects ?? []).every((effect) => used.has(effect.id))) return document;
	return {
		...document,
		shaderEffects: (document.shaderEffects ?? []).filter((effect) => used.has(effect.id)),
	};
}

/** The tier of a number of `frame()` reads per pixel, as the compositor computes it. */
export function shaderEffectTierOf(frameReads: number): ShaderEffectTier {
	if (frameReads <= 8) return "light";
	if (frameReads <= 32) return "medium";
	if (frameReads <= 128) return "heavy";
	return "very-heavy";
}

/** The longest span a tier is recommended for, in seconds (spec C.7). */
const TIER_SPAN_SEC: Record<ShaderEffectTier, number> = {
	light: Number.POSITIVE_INFINITY,
	medium: 60,
	heavy: 10,
	"very-heavy": 3,
};

/** The recommendation an agent gets when a tier runs longer than it is meant to, else null. */
export function shaderEffectCostAdvice(tier: ShaderEffectTier, spanSec: number): string | null {
	if (spanSec <= TIER_SPAN_SEC[tier]) return null;
	const lighter =
		tier === "very-heavy" ? "heavy or lighter" : tier === "heavy" ? "medium or light" : "light";
	return `${tier} over ${spanSec.toFixed(1)} s: this tier is meant for at most ${TIER_SPAN_SEC[tier]} s; for a region this long, aim ${lighter}. It is a recommendation, not a limit.`;
}

/** Two definitions that draw and read the same: everything but the cached cost. */
function sameShaderEffect(a: AxcutShaderEffect, b: AxcutShaderEffect): boolean {
	return (
		a.name === b.name &&
		a.description === b.description &&
		a.contract === b.contract &&
		a.code === b.code &&
		JSON.stringify(a.params) === JSON.stringify(b.params)
	);
}

/**
 * `document` with a pasted effect region (its fragments, already anchored) and its definition,
 * recreated when the project does not have it: a region copied from another project. A project
 * holding a different definition under that id (the effect was copied, then edited on one side)
 * keeps it, and the paste gets its own (`newId`). `null` when the region would overlap an effect
 * already there, since one effect runs at a time.
 */
export function withPastedShaderEffect(
	document: AxcutDocument,
	definition: AxcutShaderEffect,
	fragments: AxcutShaderEffectRange[],
	newId: () => string,
): AxcutDocument | null {
	const ranges = document.shaderEffectRanges ?? [];
	const overlaps = fragments.some((f) =>
		ranges.some((r) => r.startMs < f.endMs && r.endMs > f.startMs),
	);
	if (overlaps) return null;
	const effects = document.shaderEffects ?? [];
	const held = effects.find((e) => e.id === definition.id);
	if (held && sameShaderEffect(held, definition)) {
		return { ...document, shaderEffectRanges: [...ranges, ...fragments] };
	}
	const pasted = held ? { ...definition, id: newId() } : definition;
	return {
		...document,
		shaderEffects: [...effects, pasted],
		shaderEffectRanges: [...ranges, ...fragments.map((f) => ({ ...f, effectId: pasted.id }))],
	};
}
