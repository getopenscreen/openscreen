# Modelled cursor themes

`3d-concept.png` is a visual reference, not a render from OpenScreen. Mode 15
now ray-marches each cursor silhouette with an authored grayscale height map
for its top surface. This changes the surface normals, lighting and shadow as
the cursor tilts; it is still a raster height-field model rather than an
individually rigged mesh.

The five original packs have separate PNG faces and relief maps for their
arrow and pointing hand. Their model hotspots are authored independently from
the 2D hotspots. Text, resize, move and other OS cursor states keep their own
built-in shapes and use the compositor's beveled extrusion while 3D is on.
Themes without a dedicated model face use the same state-specific fallback.

The face PNG supplies color only. Its alpha defines the silhouette and its
separate grayscale PNG defines height (black at the edge, brighter at the
raised face). The height scale is 0.12 model units. Pop Coral's decorative
offset and rays are omitted from the sculpted face; Pixel Candy uses stepped
height bands; Prism Glow varies its facets; Studio Ink recesses the ivory
inlay and removes the glove outline; Star Sprout raises the star and leaves.
Regenerate both faces and relief maps with
`node scripts/generate-original-cursor-themes.mjs`.

| Theme | Arrow model | Hand model |
| --- | --- | --- |
| Studio Ink | Matte black body; ivory line becomes an inset groove, not an outer stroke. | Ivory glove with convex palm and separate rounded fingers; no dark silhouette outline. |
| Prism Glow | Solid transparent crystal with its own faceted edges; no navy ink stroke. | Individually faceted crystal fingers and palm; no navy ink stroke. |
| Pop Coral | Soft coral rubber body with a gently rounded tip and no fake yellow offset or navy rim. | Plump yellow rubber fingers and palm; no navy outline, with any accent placed on a physical cuff. |
| Pixel Candy | Pink and mint face voxels; purple is visible side/back blocks, not a painted line. | Distinct finger voxels and small bevels; purple stays as real side/back blocks. |
| Star Sprout | Mint ceramic body without a heavy blue border; star and leaves are attached raised pieces. | Ivory glove without blue border; mint cuff and tiny star/leaves are separate parts. |

The model keeps the compositor's contact shadows and stable hotspot during
yaw, pitch, click and size changes. A future mesh pipeline could give fingers
more undercut and independent articulation; the current height field already
provides a style-specific convex palm, raised finger ridges and sculpted arrow
faces while remaining compatible with the shared ray-march renderer.
