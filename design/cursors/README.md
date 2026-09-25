# Original OpenScreen cursor themes

These five themes replace the removed Sweezy packs. Their SVG shapes and palettes were
drawn for OpenScreen. Image generation was used for visual exploration; no generated
bitmap or third-party cursor file is shipped. The SVGs here are the editable masters.

| Theme | Intent |
| --- | --- |
| Studio Ink | Quiet, high-contrast choice for product demos |
| Prism Glow | Vivid color without losing the cursor silhouette |
| Pop Coral | Warm, playful choice for casual recordings |
| Pixel Candy | A small retro option for people who liked pixel packs |
| Star Sprout | An original tiny character for people who liked mascot packs |

Each theme has `arrow.svg` and `pointer.svg`. The matching transparent 128×128 PNGs
are in `public/cursors/<theme>/`. Run `node scripts/generate-original-cursor-themes.mjs`
after editing an SVG to regenerate its PNG. The script creates an SVG only if it does
not exist, so edits to the masters are preserved.

Hotspots are expressed in the SVG's 32×32 coordinate system in
`src/lib/cursor/cursorThemes.ts`. Keep a hotspot on the arrow's tip or the hand's
raised fingertip when changing a shape. Other cursor states use the built-in art.

`contact-sheet.png` shows the sprites enlarged on a light background;
`dark-32px.png` shows them at their 32-pixel reference size on a dark background.
