# OpenScreen Editor — UI kit

A high-fidelity recreation of the OpenScreen Editor's **Edit** view, composed from the design
system primitives. It is a visual + light-interaction recreation, not production code.

## Screen

`index.html` — the full editor shell in **Edit** mode:
- **Topbar** — logo lockup, project switcher, Media/Edit/Rec stage tabs, save state, theme toggle, Export.
- **Agent panel** (left, 392px) — recipe header + progress, a conversation (`ChatBubble` +
  `ProposalCard`), quick-action `Chip` row, and the composer (`TextField`).
- **Stage** (center) — 16:9 preview with rule-of-thirds grid, timecode + resolution badges, webcam
  PiP, and the floating **inspector** (facet rail via `FacetRailButton` + the Composition pane:
  Format `ChoiceRow`, a Background section with the 8-per-row wallpaper grid and blur `Slider`,
  a Frame section with free-row `Slider`s and the named Shadow levels).
- **Timeline ribbon** (bottom) — header row with the tools, the transport centred, and the
  shortcut hints (no seek bar: the ruler seeks); ruler with the violet playhead; the annotation /
  speed / trim / zoom lanes (candy `TimelinePill`s, zoom in blue); the clips as brand-green candy
  cards with dark-ink waveforms; and the zoom/pan nav bar.

Interaction is intentionally shallow: the stage tabs switch, the theme toggles, sliders/switches
move, chips fill the composer. It demonstrates the look and the component composition — the real
editing engine is out of scope.

## Composition

Everything pulls tokens from `../../styles.css` and components from the generated bundle. The
screen resolves the bundle namespace defensively (`pick(name)`) so it works regardless of the
compiled namespace name.
