import {
	BACKGROUND_FADE_MS,
	BACKGROUND_SIZES,
	BACKGROUND_WALLPAPERS,
	backgroundFallback,
	backgroundSrcSet,
} from "../../lib/background-media.ts";

export interface BackgroundLayer {
	load: (index: number) => Promise<void>;
	show: (visible: boolean, foreground?: boolean) => void;
}

/** Two decoded layers: keep the current picture until its replacement is ready.
 * Requests during a decode or fade collapse to the latest scroll position. */
export function createBackgrounds(
	layers: [BackgroundLayer, BackgroundLayer],
	rest: number,
	settle: () => Promise<void>,
) {
	let active = 0;
	let shown = rest;
	let wanted = rest;
	let running = false;
	let disposed = false;
	const loaded: (number | null)[] = [rest, null];

	async function prepare(slot: number, index: number): Promise<boolean> {
		if (loaded[slot] === index) return true;
		loaded[slot] = null;
		try {
			await layers[slot].load(index);
			loaded[slot] = index;
			return !disposed;
		} catch {
			// Both CDN and local fallback failed; retain the painted layer.
			return false;
		}
	}

	async function pump() {
		if (running || disposed) return;
		running = true;
		while (!disposed) {
			const slot = 1 - active;
			if (wanted !== shown) {
				const next = wanted;
				if (!(await prepare(slot, next))) break;
				if (disposed) break;
				if (next !== wanted) continue;
				const outgoing = active;
				layers[outgoing].show(true, false);
				layers[slot].show(true, true);
				active = slot;
				shown = next;
				await settle();
				if (!disposed) layers[outgoing].show(false, false);
			} else {
				// Reuse the faded-out layer for the next swatch, never all four.
				const next = (shown + 1) % BACKGROUND_WALLPAPERS.length;
				const ready = await prepare(slot, next);
				if (!ready && wanted === next) break;
				if (wanted === shown) break;
			}
		}
		running = false;
	}

	void pump();
	return {
		show(index: number) {
			if (index === wanted || disposed) return;
			wanted = index;
			void pump();
		},
		dispose() {
			disposed = true;
		},
	};
}

function setSource(picture: HTMLPictureElement, index: number) {
	const img = picture.querySelector("img")!;
	for (const source of Array.from(picture.querySelectorAll("source"))) {
		source.srcset = backgroundSrcSet(index, source.type === "image/avif" ? "avif" : "webp");
	}
	img.sizes = BACKGROUND_SIZES;
	img.src = backgroundFallback(index);
	picture.dataset.background = String(index);
}

/** A supported format can still fail to load; <picture> does not try its fallback then. */
export function restoreLocalBackground(img: HTMLImageElement) {
	if (img.currentSrc === img.src) return;
	for (const source of Array.from(img.parentElement!.querySelectorAll("source"))) {
		source.removeAttribute("srcset");
	}
	// Removing the sources lets the browser select img.src, the local JPEG.
}

export function attachBackgrounds(root: HTMLElement, rest: number) {
	const pictures = Array.from(root.querySelectorAll<HTMLPictureElement>("[data-background-layer]"));
	let disposed = false;
	const layers = pictures.map(
		(picture): BackgroundLayer => ({
			async load(index) {
				setSource(picture, index);
				const img = picture.querySelector("img")!;
				try {
					await img.decode();
				} catch {
					if (disposed) return;
					for (const source of Array.from(picture.querySelectorAll("source"))) {
						source.removeAttribute("srcset");
					}
					img.src = backgroundFallback(index);
					await img.decode();
				}
				// Establish the hidden opacity before reusing a cached image in the
				// same frame. This style read happens once per image, never on scroll.
				if (!disposed) void window.getComputedStyle(picture).opacity;
			},
			show(visible, foreground = false) {
				picture.style.zIndex = foreground ? "1" : "0";
				picture.dataset.visible = String(visible);
			},
		}),
	) as [BackgroundLayer, BackgroundLayer];
	const controller = createBackgrounds(
		layers,
		rest,
		() => new Promise((resolve) => setTimeout(resolve, BACKGROUND_FADE_MS)),
	);
	return {
		show: controller.show,
		dispose() {
			disposed = true;
			controller.dispose();
			setSource(pictures[0], rest);
			pictures[0].dataset.visible = "true";
			pictures[1].dataset.visible = "false";
			for (const picture of pictures) picture.style.removeProperty("z-index");
			for (const source of Array.from(pictures[1].querySelectorAll("source"))) {
				source.removeAttribute("srcset");
			}
			pictures[1].querySelector("img")!.removeAttribute("src");
		},
	};
}
