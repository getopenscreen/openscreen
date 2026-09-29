# Cursor refresh requirements

This file consolidates the cursor decisions from the design and implementation
conversation. It is the working acceptance list for the replacement themes and
their 3D models.

## Replacement artwork

- Remove the Sweezy packs because redistribution rights are unclear or
  insufficient.
- Ship original OpenScreen cursor artwork as clean, transparent PNGs. Do not
  vectorize the generated artwork or ship SVG intermediates.
- Preserve cursor readability and useful choices for users who liked the old
  pixel, character, colorful, glossy, or playful cursors.
- Keep the range professional, attractive, and varied without copying
  Screen Studio or third-party packs.
- Keep correct arrow-tip and raised-fingertip hotspots and preserve other OS
  cursor states through the built-in artwork.

## 3D option

- Every replacement theme and supported cursor state must work with the
  existing 3D cursor option.
- Every replacement arrow and hand is a real volume, sculpted in the
  compositor's shaders (`crates/compositor/src/sculpt.rs`): lighting, normals,
  self shadows and contact shadows respond to cursor tilt and rotation. A PNG
  face or a height map is not a model.
- A rounded extrusion of the PNG silhouette remains the fallback for cursor
  states that do not have a dedicated theme model. The five replacement packs
  add style-specific volume: a glove with separate fingers, cut crystal facets,
  beveled voxels, and cushions set in the rim of their drawn outline.
- Model the arrow and hand separately for every theme. Do not apply one
  contour, material, or roundness rule to all designs.
- Preserve the cursor hotspot through hover, tilt, yaw, click, and size changes.
- Reuse the compositor's 3D lighting and contact shadows. The surface must
  change with the compositor camera; a static image of a 3D render is not a
  model.

## Theme-specific shape and outline decisions

| Theme | Arrow | Hand |
| --- | --- | --- |
| Studio Ink | Black rim, raised ivory band, recessed satin black field. | Ivory glove cushion; the black outline stays as a physical rim, with black ridges between the fingers. |
| Prism Glow | The faceted drawing extruded as drawn, beveled edge; no sculpted model. | The same. |
| Pop Coral | Coral cushion in a navy rim; the yellow offset becomes a layer behind it; the click dashes become physical pieces. | Yellow glove cushion in a navy rim; the coral offset becomes a layer behind it; the coral click dashes become physical pieces. |
| Pixel Candy | Keep the stepped voxel form; purple is a ring of physical blocks set behind the face, not a flat outline. | Stepped voxel fingers and palm; preserve purple as a physical ring of blocks behind the face. |
| Star Sprout | Puffy mint cushion; the navy outline stays as a physical rim (a navy tray and a rounded bead) around it, the star and its leaves in front, each in its own navy rim. | Puffy ivory glove in the same navy rim, with navy ridges between the fingers; separate mint cuff framed in navy; the star and leaves in front, as in `star-sprout/3d-reference.png`. |

The 2D PNG may keep a drawn contour where it helps readability. Its contour
must not be copied blindly onto the 3D material: decide per model whether it
becomes an inlay, side material, separate piece, or disappears.

## Review references

- `contact-sheet.png`: 2D PNG themes.
- `3d-concept.png`: the 3D reference sheet the ten models follow, not
  rendered by the app.
- `star-sprout/3d-reference.png`: a closer view of the Star Sprout hand; also
  not rendered by the app.
- `3d-direction.md`: per-theme modeling notes.
- `README.md`: source PNG and preparation workflow.

The intended deliverable is the actual in-app 3D treatment, not just these
references.
