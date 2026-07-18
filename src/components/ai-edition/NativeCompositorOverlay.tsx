import { useRef, useState } from "react";
import { useNativeCompositorView } from "@/native";

/**
 * POC Option A — monte une fenêtre D3D11 native (compositeur poc-d3d, via
 * `compositor_view.node`) par-dessus la zone preview, positionnée sur ce `<div>`
 * placeholder et pilotée par `useNativeCompositorView`. La fenêtre native rend
 * le compositing ; le `<div>` ne sert qu'à donner sa géométrie (le hook sync le
 * rect natif au resize/scroll).
 *
 * Opt-in via le flag Vite `VITE_NATIVE_COMPOSITOR=1` : par défaut le composant ne
 * rend rien et la preview web existante reste inchangée.
 */
export function NativeCompositorOverlay({ enabled }: { enabled: boolean }) {
	const mountRef = useRef<HTMLDivElement>(null);
	const { setParam } = useNativeCompositorView(mountRef, { enabled });
	const [blur, setBlur] = useState(false);

	if (!enabled) {
		return null;
	}

	return (
		<div
			ref={mountRef}
			data-testid="native-compositor-mount"
			style={{ position: "absolute", inset: 0, zIndex: 5 }}
		>
			<label
				style={{
					position: "absolute",
					top: 8,
					left: 8,
					zIndex: 6,
					display: "flex",
					alignItems: "center",
					gap: 6,
					background: "rgba(0,0,0,0.55)",
					color: "#fff",
					padding: "4px 8px",
					borderRadius: 6,
					font: "12px system-ui",
				}}
			>
				<input
					type="checkbox"
					checked={blur}
					onChange={(e) => {
						setBlur(e.target.checked);
						setParam("backgroundBlur", e.target.checked);
					}}
				/>
				Background blur (native)
			</label>
		</div>
	);
}
