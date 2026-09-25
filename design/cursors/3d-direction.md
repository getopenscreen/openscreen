# Direction for modelled cursor themes

`3d-concept.png` is a visual reference, not a render from OpenScreen.
The current compositor's mode 15 rounds an extruded 2D silhouette. It does
not make a convex palm, separate fingers, or a sculpted arrow body. Do not
present a bevel adjustment as the finished 3D treatment.

The production 3D version should have authored geometry for each cursor
theme and state, anchored to the same arrow tip or raised fingertip as its
flat PNG. The PNG supplies its colour and surface pattern; geometry supplies
the volume. Pop Coral's decorative offset layer and rays belong to its flat
art, not its 3D body. The prepared single-surface PNGs can be used as its
3D colour reference.

| Theme | Volume direction |
| --- | --- |
| Studio Ink | Solid sculpted arrow; convex palm and distinct rounded fingers |
| Prism Glow | Sharp crystal facets and angular finger segments |
| Pop Coral | Soft rubber body with generous rounded volume |
| Pixel Candy | Stepped voxel silhouette with restrained edge rounding |
| Star Sprout | Soft ceramic body; star and leaves as separate raised details |

The model needs a true changing surface normal across the face, visible
depth in a three-quarter view, correct contact shadows, and a stable hotspot
during yaw, pitch, click and size changes. A static PNG of a 3D render is
insufficient: the compositor's camera and lighting must see the geometry.
