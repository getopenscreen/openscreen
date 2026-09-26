# Modelled cursor themes

`3d-concept.png` is a visual reference, not a render from OpenScreen.

With the 3D option on, mode 15 ray-marches each original theme's arrow and hand
as a sculpted model: signed distance functions written in the compositor's three
shaders (HLSL, Metal, WGSL), not a PNG face or a height map.
`crates/compositor/src/sculpt.rs` names the ten models and holds their bounding
boxes and hotspots. The scene names the model (`"<theme>/<state>"`); text,
resize, move and the other OS states keep their built-in art and the
compositor's beveled extrusion.

| Theme | Arrow model | Hand model |
| --- | --- | --- |
| Studio Ink | Matte black body with an ivory piping set in from the edge. | Ivory glove with a dark cuff. |
| Prism Glow | Cut crystal: flat facets, a polygonal silhouette, cyan to violet dispersion. | The same glove cut into faceted fingers and palm. |
| Pop Coral | Soft coral rubber with rounded edges and a gentle dome. | Plump yellow rubber glove with a navy cuff. |
| Pixel Candy | Beveled voxels: a pink face with mint and pale pink edges, purple blocks one step behind. | Voxel glove with the same colours and purple back layer. |
| Star Sprout | Glossy mint ceramic carrying a star with a face and two leaves. | Ivory glove with a mint cuff and the same star. |

All models share one close lamp: a gradient and a highlight even on flat faces,
soft self shadows, ambient occlusion and a studio environment in the
reflections, plus the compositor's cast and contact shadows on the screen. The
hotspot stays on the arrow tip and the index fingertip through hover, tilt, yaw,
click and size changes.

To change a model, edit it in all three shaders (`sculpt_proto`,
`sculpt_material`) and keep `sculpt.rs` in step: its boxes must contain the
shapes, and a test checks that the shaders mirror its constants. Pixel Candy's
arrow voxels are sampled from the arrow polygon; `sculpt.rs` says how.
