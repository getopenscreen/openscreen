/** Above captions (`CAPTION_Z_INDEX_BASE` = 100_000), so the label sits on top. */
export const DESK_LABEL_Z_INDEX = 200_000;
/**
 * The desk-view label's text animation. It has no timing of its own: the compositor draws the
 * label at the camera cover's strength (`annotation_text_state` in
 * crates/compositor/src/text_anim.rs), so the label spans its whole section and the cover alone
 * decides when it shows — on the screen clock, like the cover.
 */
export const DESK_COVER_ANIMATION = "deskCover";
