# Direction for modelled cursor themes

`3d-concept.png` is a visual reference, not a render from OpenScreen.
The current compositor's mode 15 rounds an extruded 2D silhouette. It does
not make a convex palm, separate fingers, or a sculpted arrow body. Do not
present a bevel adjustment as the finished 3D treatment.

The production 3D version should have authored geometry and materials for
each cursor theme and state, anchored to the same arrow tip or raised
fingertip as its flat PNG. The flat PNG supplies a palette and design
reference; using it unchanged as a 3D face texture would bake its 2D ink
contour onto the model. Decide separately whether each contour becomes a
physical inlay, a side material, or disappears. Pop Coral's decorative
offset layer and rays belong to its flat art, not its 3D body. Its prepared
single-surface PNGs are colour references, not final 3D textures.

| Theme | Arrow model | Hand model |
| --- | --- | --- |
| Studio Ink | Matte black body; ivory line becomes an inset groove, not an outer stroke. | Ivory glove with convex palm and separate rounded fingers; no dark silhouette outline. |
| Prism Glow | Solid transparent crystal with its own faceted edges; no navy ink stroke. | Individually faceted crystal fingers and palm; no navy ink stroke. |
| Pop Coral | Soft coral rubber body with a gently rounded tip and no fake yellow offset or navy rim. | Plump yellow rubber fingers and palm; no navy outline, with any accent placed on a physical cuff. |
| Pixel Candy | Pink and mint face voxels; purple is visible side/back blocks, not a painted line. | Distinct finger voxels and small bevels; purple stays as real side/back blocks. |
| Star Sprout | Mint ceramic body without a heavy blue border; star and leaves are attached raised pieces. | Ivory glove without blue border; mint cuff and tiny star/leaves are separate parts. |

The model needs a true changing surface normal across the face, visible
depth in a three-quarter view, correct contact shadows, and a stable hotspot
during yaw, pitch, click and size changes. A static PNG of a 3D render is
insufficient: the compositor's camera and lighting must see the geometry.
