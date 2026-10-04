# Original OpenScreen cursor themes

These six themes replace the removed Sweezy packs. The artwork was created for
OpenScreen as transparent raster images. The PNGs in this directory are the
original high-resolution masters; there is no SVG conversion step. Glass Lens is
the exception: it has no raster master (see below).

| Theme | Intent |
| --- | --- |
| Studio Ink | Quiet, high-contrast choice for product demos |
| Prism Glow | Vivid color without losing the cursor silhouette |
| Pop Coral | Warm, playful choice for casual recordings |
| Pixel Candy | A small retro option for people who liked pixel packs |
| Star Sprout | An original tiny character for people who liked mascot packs |
| Glass Lens | A clear lens of glass in a defined outline: the recording shows through the cursor |

Each `source.png` contains an arrow on the left and a hand on the right. Run
`node scripts/generate-original-cursor-themes.mjs` to crop, remove low-alpha
fringe pixels, and resize them into transparent 128 × 128 PNGs under
`public/cursors/<theme>/`. It prints the normalized tip hotspots; copy them into
`src/lib/cursor/cursorThemes.ts` after changing a master.

With the 3D option on, the compositor draws the arrow and hand of Studio Ink,
Pop Coral, Pixel Candy and Star Sprout as models sculpted in its shaders
(`crates/compositor/src/sculpt.rs`), not from these PNGs. Prism Glow's arrow and
hand are glass crystals meshed on its drawing (`prism-glow/model/`). The theme
picker and the flat cursor keep using the PNGs. Text, resize, move and other
states remain state-accurate through the built-in art and receive the shared 3D
extrusion.

Glass Lens is glass with the 3D option off too: the compositor draws its arrow
and hand as its model seen face on (mode 19), a lens that refracts the picture
under it, instead of a PNG. Its shapes are the Studio Ink arrow and glove, and
`node scripts/generate-glass-lens-cursor.mjs` draws its picker PNGs from the
same distance fields, read from the shaders, then prints their hotspots.

`contact-sheet.png` shows the sprites enlarged on a light background;
`dark-32px.png` shows them at their 32-pixel reference size on a dark background.
The 3D modeling direction and the reference sheet the models follow are in
`3d-direction.md` and `3d-concept.png`; `star-sprout/3d-reference.png` is a closer
view of the Star Sprout hand.
The consolidated acceptance list is in `requirements.md`.
