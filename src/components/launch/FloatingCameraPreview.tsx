import { Minus, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useScopedT } from "../../contexts/I18nContext";
import { CAMERA_PREVIEW_SIZES } from "../../lib/cameraPreview";
import styles from "./FloatingCameraPreview.module.css";

export function FloatingCameraPreview() {
	const t = useScopedT("launch");
	const image = useRef<HTMLImageElement>(null);
	const [ready, setReady] = useState(false);
	const [sizeIndex, setSizeIndex] = useState(1);
	const resize = (next: number) => {
		void window.electronAPI
			?.resizeCameraPreview?.(CAMERA_PREVIEW_SIZES[next])
			.then(() => setSizeIndex(next))
			.catch((error: unknown) => console.warn("Could not resize camera preview:", error));
	};
	useEffect(
		() =>
			window.electronAPI?.onCameraPreviewFrame?.((jpeg) => {
				if (image.current) image.current.src = jpeg;
				setReady(true);
			}),
		[],
	);

	return (
		<div className={styles.preview} data-testid="floating-camera-preview">
			<img ref={image} alt={t("floatingCamera.title")} hidden={!ready} draggable={false} />
			{!ready && <span>{t("deviceSettings.previewUnavailable")}</span>}
			<button
				type="button"
				className={styles.hide}
				aria-label={t("floatingCamera.hide")}
				onClick={() => void window.electronAPI?.hideCameraPreview?.()}
			>
				<X size={16} aria-hidden="true" />
			</button>
			<div className={styles.sizeControls}>
				<button
					type="button"
					aria-label={t("floatingCamera.smaller")}
					disabled={sizeIndex === 0}
					onClick={() => resize(sizeIndex - 1)}
				>
					<Minus size={16} aria-hidden="true" />
				</button>
				<button
					type="button"
					aria-label={t("floatingCamera.larger")}
					disabled={sizeIndex === CAMERA_PREVIEW_SIZES.length - 1}
					onClick={() => resize(sizeIndex + 1)}
				>
					<Plus size={16} aria-hidden="true" />
				</button>
			</div>
		</div>
	);
}
