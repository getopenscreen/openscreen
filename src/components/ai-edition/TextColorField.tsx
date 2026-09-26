import { useScopedT } from "@/contexts/I18nContext";
import { paletteFor, readableText } from "@/lib/ai-edition/textContrast";
import { ColorField } from "./ColorField";

/**
 * The colour of text that sits on a plate: the palette entries that read on that plate first,
 * the free wheel last, folded behind its swatch. A pair under 4.5:1 is never offered, and a
 * wheel colour that would vanish on the plate is pushed just far enough toward white or black.
 */
export function TextColorField({
	value,
	plate,
	label,
	disabled,
	onChange,
	onCommit,
}: {
	value: string;
	/** The plate behind the text, as CSS; `"transparent"` when there is none. */
	plate: string;
	label: string;
	disabled?: boolean;
	onChange: (next: string) => void;
	onCommit?: () => void;
}) {
	const te = useScopedT("editor");
	const palette = paletteFor(plate);
	return (
		<div role="group" aria-label={label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
			{palette.map((color) => {
				const active = value.toLowerCase() === color;
				return (
					<button
						key={color}
						type="button"
						title={color}
						aria-label={te("inspector.setColor", { color })}
						aria-pressed={active}
						disabled={disabled}
						onClick={() => {
							onChange(color);
							onCommit?.();
						}}
						style={{
							width: 22,
							height: 22,
							padding: 0,
							borderRadius: 999,
							background: color,
							border: active ? "2px solid var(--accent)" : "1px solid var(--border-hi)",
							cursor: disabled ? "default" : "pointer",
							opacity: disabled ? 0.5 : 1,
						}}
					/>
				);
			})}
			<ColorField
				label={label}
				value={value}
				disabled={disabled}
				presets={palette}
				onChange={(next) => onChange(readableText(next, plate))}
				onCommit={onCommit}
			/>
		</div>
	);
}
