import React from 'react';

/**
 * OpenScreen Slider — a continuous amount (padding, roundness, blur 0–100 %, cursor
 * size). Source: `.sliderCell` in src/components/ai-edition/NewEditorShell.module.css.
 *
 * A free row, never a card: label left, the value right in --muted body text (not mint,
 * not mono), a 6px track filled in the brand colour. When the number has no unit (a
 * cursor size of "30.0") show no value at all: `format` returns null and the track's
 * position is the value. When the number means nothing to a user (shadow, click
 * bounce), use a ChoiceRow of named levels instead of a slider.
 * Pass `bare` for the track alone.
 */
export function Slider({
  label,
  value = 0,
  min = 0,
  max = 100,
  step = 1,
  format,
  onChange,
  bare = false,
  style = {},
}) {
  const pct = ((value - min) / (max - min)) * 100;
  const display = format ? format(value) : value;

  const input = (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange && onChange(Number(e.target.value))}
      style={{
        width: '100%',
        display: 'block',
        backgroundImage: `linear-gradient(var(--brand),var(--brand)), linear-gradient(var(--border-hi),var(--border-hi))`,
        backgroundSize: `${pct}% 6px, 100% 6px`,
      }}
    />
  );

  if (bare) return input;

  return (
    <div style={{ display: 'grid', gap: 10, padding: '12px 0', ...style }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 20 }}>
        <span style={{ font: '500 13px/1.3 var(--font-body)', color: 'var(--fg-2)', marginRight: 'auto' }}>{label}</span>
        {display != null && (
          <span style={{ font: '500 12px/1.3 var(--font-body)', fontVariantNumeric: 'tabular-nums', color: 'var(--muted)' }}>{display}</span>
        )}
      </div>
      {input}
    </div>
  );
}
