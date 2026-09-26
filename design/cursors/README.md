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
`public/cursors/<theme>/`. Each `model-source.png` is a separate raster face
pair for the 3D option. The same script builds the model face PNGs and aligned
grayscale relief PNGs; the relief is not vector art. It prints the normalized
tip hotspots; copy them into `src/lib/cursor/cursorThemes.ts` after changing a
master.

The model face is selected only while the existing 3D option is enabled. The
theme picker and normal cursor rendering continue to use each flat `source.png`
version. Text, resize, move and other states remain state-accurate through the
built-in art and receive the shared 3D extrusion. Pop Coral's older
`source-3d.png` remains a reference for its offset-free treatment.

`contact-sheet.png` shows the sprites enlarged on a light background;
`dark-32px.png` shows them at their 32-pixel reference size on a dark background.
`model-face-sheet.png` compares the separate 3D arrow and hand faces.
The 3D modeling direction and concept image are in `3d-direction.md` and
`3d-concept.png`.
The consolidated acceptance list is in `requirements.md`.
