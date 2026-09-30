# Modelled cursor themes

`3d-concept.png` is a visual reference, not a render from OpenScreen.

With the 3D option on, mode 15 ray-marches the arrow and hand of Studio Ink, Pop
Coral, Pixel Candy and Star Sprout as sculpted models: signed distance functions
written in the compositor's three shaders (HLSL, Metal, WGSL), not a PNG face or
a height map. Prism Glow's arrow and hand are glass crystals: a triangle mesh
traced on its drawing, ray-traced in a navy rim. `crates/compositor/src/sculpt.rs`
names the ten models and holds their bounding boxes and hotspots. The scene names
the model (`"<theme>/<state>"`); text, resize, move and the other OS states keep
their built-in art and the compositor's beveled extrusion.

| Theme | Arrow model | Hand model |
| --- | --- | --- |
| Studio Ink | Black rim, a raised ivory band, a recessed satin black field. | Ivory glove cushion in a black rim, black ridges between the fingers. |
| Prism Glow | A glass crystal cut along the facets of its drawing, set in a thin navy rim. The recording shows through it, refracted with a slight dispersion; each facet glows faintly in its drawn colour, and a light line marks its folds. | The same crystal: a facet for each plane of the drawn hand, the fingers and thumb included. |
| Pop Coral | Cut paper: flat-topped sheets, no rounded bead or gloss. A coral sheet on a navy sheet, a yellow sheet behind them offset down-left, two yellow click dashes. | A yellow sheet on a navy sheet, the navy showing between the fingers, a coral sheet behind offset down-left, two coral click dashes. |
| Pixel Candy | Simplified pixel art, one cube per pixel: a plum outline, a pink body with a pale highlight down the lit edge and a darker shade along the outline. The 3D model and the 2D sprite come from the same grid. | The same, a pixel hand: the index up, three knuckles apart, the thumb. |
| Star Sprout | Glossy mint cushion framed by the navy outline of its drawing, carrying a star with a face and two leaves. | Ivory glove cushion in the same navy frame, navy ridges between the fingers, a mint cuff and the same star. |

Studio Ink, Pop Coral and Star Sprout keep their drawn outline, as in
`3d-concept.png` (and `star-sprout/3d-reference.png` for the Star Sprout hand).
Each piece is a tray in the outline colour under its silhouette, a rounded bead
along the stroke and a puffy colour cushion inside it; the grooves between the
fingers become ridges of the outline colour. The three arrows share one polygon
and the three gloves one construction, each glove measured on its own drawing
(`RIM_POLY`, `RIM_GLOVE`). Pop Coral turns the same shapes into flat paper
sheets instead (`s_paper`). What stands in front is theme-specific: Studio
Ink's ivory band, Pop Coral's yellow and coral layers and click dashes, Star
Sprout's cuff, star, leaves and eyes.

Prism Glow is built from its 2D drawing alone (`prism-glow/source.png`), not from
`3d-concept.png`. `prism-glow/model/` holds the mesh: `prism_geo.py` lists its
vertices, heights and facets and writes `prism.json`; `build_blend.py` builds
`prism-glow.blend` and `prism-glow.glb` from it in Blender; `export_compositor.py`
writes the mesh into `crates/compositor/src/prism_mesh.rs` and the three shaders.
The compositor ray-traces the crystal, its triangles grouped in bounding boxes that
a ray skips when it misses them: refraction per colour
channel, total internal reflection, and an exit through its flat base onto the
recording under the cursor. The rim is its silhouette extruded, a distance field
like the other models: it gives the coverage and the shadows.

All models share one close lamp: a gradient and a highlight even on flat faces,
soft self shadows, ambient occlusion and a studio environment in the
reflections, plus the compositor's cast and contact shadows on the screen. The
hotspot stays on the arrow tip and the index fingertip through hover, tilt, yaw,
click and size changes.

To change a model, edit it in all three shaders (`sculpt_proto`,
`sculpt_material`) and keep `sculpt.rs` in step: its boxes must contain the
shapes, and a test checks that the shaders mirror its constants. Pixel Candy's
voxel grids are tables written by `scripts/generate-pixel-candy-voxels.mjs`:
change a grid there and run the script; it rewrites all three shaders, and a
test checks the tables agree. To change Prism Glow, edit `prism_geo.py`, run it,
run `build_blend.py` in Blender, then `export_compositor.py`; a test checks that
the three shaders carry the mesh of `prism_mesh.rs`.
