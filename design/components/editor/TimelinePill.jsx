import React from 'react';

/**
 * OpenScreen TimelinePill — a labelled effect on a timeline lane.
 * Source: `.lanePill` in src/components/ai-edition/v4/EditorShellV4.module.css.
 *
 * "Candy": a solid gradient in the lane colour with a glow under it (--candy-glow,
 * 12% light / 35% dark), no border, no gloss line, and dark ink #0b1220 on every
 * colour: the light lane colours cannot carry white. Zoom is blue (--zoom) so it never
 * reads as the recording clip, which owns the brand green (--clip).
 * `widthPct` spans a range; leave it null to size to the content.
 */
const TONES = {
  zoom: 'var(--zoom)',
  annotation: 'var(--annotation)',
  speed: 'var(--speed)',
  trim: 'var(--danger)',
  danger: 'var(--danger)',
  camera: '#a855f7',
};

export function TimelinePill({
  tone = 'zoom',
  icon = null,
  children,
  leftPct = 0,
  widthPct = null,
  selected = false,
  style = {},
}) {
  const c = TONES[tone] || TONES.zoom;
  return (
    <span
      style={{
        position: 'absolute',
        top: 1,
        left: `${leftPct}%`,
        width: widthPct == null ? 'max-content' : `${widthPct}%`,
        minWidth: 1,
        height: 22,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '0 8px 0 7px',
        borderRadius: 8,
        border: '1px solid transparent',
        background: `linear-gradient(180deg, color-mix(in oklab, ${c} 72%, white), ${c}) border-box`,
        boxShadow: selected
          ? `0 0 0 2px var(--bg), 0 0 0 3.5px ${c}`
          : `0 2px 6px color-mix(in oklab, ${c} var(--candy-glow), transparent)`,
        color: '#0b1220',
        fontSize: 12,
        fontWeight: 600,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        boxSizing: 'border-box',
        ...style,
      }}
    >
      {icon}
      {children}
    </span>
  );
}
