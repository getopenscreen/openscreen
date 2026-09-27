import React from 'react';

/**
 * OpenScreen Select — native dropdown styled to match. Only for a LONG list
 * (the 15 translation targets). A fixed choice of a few values is a ChoiceRow:
 * one click, every value visible (commit e4c56004).
 */
export function Select({
  options = [],
  value,
  onChange,
  fullWidth = true,
  style = {},
  ...rest
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange && onChange(e.target.value)}
      style={{
        width: fullWidth ? '100%' : undefined,
        height: 36,
        padding: '0 11px',
        borderRadius: 10,
        border: '1px solid var(--border)',
        background: 'var(--surface-2)',
        color: 'var(--fg-2)',
        fontFamily: 'var(--font-display)',
        fontSize: 12.5,
        fontWeight: 500,
        outline: 'none',
        cursor: 'pointer',
        ...style,
      }}
      {...rest}
    >
      {options.map((opt) => {
        const val = typeof opt === 'string' ? opt : opt.value;
        const label = typeof opt === 'string' ? opt : opt.label;
        return <option key={val} value={val}>{label}</option>;
      })}
    </select>
  );
}
