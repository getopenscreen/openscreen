import { GIF_SIZE_PRESETS, type GifSizePreset } from "./types";

interface Dims {
	width: number;
	height: number;
}

/** A preset caps the height of the "Source" size and never upscales; `original` is the source. */
export function gifPresetDims(preset: GifSizePreset, source: Dims): Dims {
	const maxHeight = GIF_SIZE_PRESETS[preset].maxHeight;
	if (source.height <= maxHeight) return { width: source.width, height: source.height };
	const scale = maxHeight / source.height;
	// Even dimensions: the compositor rasterises to this size and the readback assumes a
	// tightly-packed RGBA buffer.
	const even = (n: number) => Math.max(2, Math.round(n * scale) & ~1);
	return { width: even(source.width), height: even(source.height) };
}

/**
 * The presets that write different files, each with the size it writes. Presets that a smaller
 * source caps to the same size collapse into the largest of them: a 584x360 project offers only
 * "Original", where all four labels used to promise heights the file never had.
 */
export function gifSizeChoices(source: Dims): { preset: GifSizePreset; dims: Dims }[] {
	const choices: { preset: GifSizePreset; dims: Dims }[] = [];
	for (const preset of Object.keys(GIF_SIZE_PRESETS) as GifSizePreset[]) {
		const dims = gifPresetDims(preset, source);
		const last = choices.at(-1);
		if (last && last.dims.width === dims.width && last.dims.height === dims.height) {
			last.preset = preset;
		} else {
			choices.push({ preset, dims });
		}
	}
	return choices;
}
