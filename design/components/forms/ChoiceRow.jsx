import React from 'react';

/**
 * OpenScreen ChoiceRow — a fixed choice picked in one click. Replaces a select or a
 * dropdown whenever the options are few and known (Format, frame style, theme, focus
 * mode, caption font, shadow and bounce levels…): every value stays visible.
 * Source: `ChoiceRow` in src/components/ai-edition/RightPanes.tsx, CSS
 * `.choiceRow / .choiceBtn / .choiceRowTiles` in NewEditorShell.module.css.
 *
 * Equal grid cells, 4px gap. The pressed option carries the app's one selected look:
 * accent border on the accent tint, fg text. `tiles` makes 44px cells for icons that
 * draw their choice. A value that matches no option (a stored level between two named
 * ones) presses nothing. Only a long list (the 15 translation targets) stays a Select.
 *
 * options: string | { value, label, icon? }; `null` leaves a hole in the grid.
 */
export function ChoiceRow({
  label,
  options = [],
  value,
  onChange,
  columns,
  tiles = false,
  disabled = false,
  style = {},
}) {
  const norm = options.map((o) => (o == null || typeof o === 'object' ? o : { value: o, label: o }));
  return (
    <div style={{ display: 'grid', gap: 6, ...style }}>
      {label && <span style={{ font: '500 13px/1.3 var(--font-body)', color: 'var(--fg-2)' }}>{label}</span>}
      <div
        role="group"
        aria-label={label}
        style={{ display: 'grid', gap: 4, gridTemplateColumns: `repeat(${columns || norm.length}, minmax(0, 1fr))` }}
      >
        {norm.map((o, i) => {
          if (o == null) return <span key={`hole-${i}`} aria-hidden="true" />;
          const pressed = o.value === value;
          return (
            <button
              key={String(o.value)}
              type="button"
              aria-pressed={pressed}
              aria-label={o.icon && !tiles ? o.label : undefined}
              title={o.label}
              disabled={disabled}
              onClick={() => !pressed && onChange && onChange(o.value)}
              style={{
                minWidth: 0,
                minHeight: tiles ? 44 : 32,
                padding: '0 6px',
                display: 'inline-flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 3,
                borderRadius: 'var(--r-md)',
                border: `1px solid ${pressed ? 'var(--accent)' : 'transparent'}`,
                background: pressed ? 'var(--accent-soft)' : 'color-mix(in oklab, var(--fg) 6%, transparent)',
                color: pressed ? 'var(--fg)' : 'var(--fg-2)',
                font: '500 12.5px/1.2 var(--font-body)',
                fontVariantNumeric: 'tabular-nums',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                cursor: disabled ? 'not-allowed' : 'pointer',
                opacity: disabled ? 0.5 : 1,
                transition: 'background var(--motion-fast) var(--ease), border-color var(--motion-fast) var(--ease)',
              }}
            >
              {o.icon}
              {o.icon ? (tiles && <span style={{ fontSize: 12 }}>{o.label}</span>) : o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
