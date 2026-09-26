# Original OpenScreen cursor themes

These five themes replace the removed Sweezy packs. The artwork was created for
OpenScreen as transparent raster images. The PNGs in this directory are the
original high-resolution masters; there is no SVG conversion step.

| Theme | Intent |
| --- | --- |
| Studio Ink | Quiet, high-contrast choice for product demos |
| Prism Glow | Vivid color without losing the cursor silhouette |
| Pop Coral | Warm, playful choice for casual recordings |
| Pixel Candy | A small retro option for people who liked pixel packs |
| Star Sprout | An original tiny character for people who liked mascot packs |

Each `source.png` contains an arrow on the left and a hand on the right. Run
`node scripts/generate-original-cursor-themes.mjs` to crop, remove low-alpha
fringe pixels, and resize them into transparent 128 × 128 PNGs under
`public/cursors/<theme>/`. It prints the normalized tip hotspots; copy them into
`src/lib/cursor/cursorThemes.ts` after changing a master.

With the 3D option on, the compositor draws each theme's arrow and hand as a
model sculpted in its shaders (`crates/compositor/src/sculpt.rs`), not from these
PNGs. The theme picker and the flat cursor keep using the PNGs. Text, resize,
move and other states remain state-accurate through the built-in art and
receive the shared 3D extrusion.

`contact-sheet.png` shows the sprites enlarged on a light background;
`dark-32px.png` shows them at their 32-pixel reference size on a dark background.
The 3D modeling direction and concept image are in `3d-direction.md` and
`3d-concept.png`.
The consolidated acceptance list is in `requirements.md`.
