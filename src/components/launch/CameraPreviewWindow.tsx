import { GripHorizontal, X } from "lucide-react";
import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from "react";
import { useScopedT } from "../../contexts/I18nContext";
import { useCameraDevices } from "../../hooks/useCameraDevices";
import { useCameraPreviewStream } from "../../hooks/useCameraPreviewStream";
import type { CameraPreviewState, CameraPreviewTransform } from "../../lib/cameraPreview";
import styles from "./CameraPreviewWindow.module.css";

const corners = ["nw", "ne", "sw", "se"] as const;
export function CameraPreviewWindow() {
	const t = useScopedT("launch");
	const [state, setState] = useState<CameraPreviewState>({ enabled: false });
	const [adjusting, setAdjusting] = useState(false);
	const video = useRef<HTMLVideoElement>(null);
	const dragging = useRef(false);
	const cameras = useCameraDevices(state.enabled, state.deviceId, state.deviceName);
	const { stream, error } = useCameraPreviewStream({
		enabled: state.enabled && cameras.isReady && !!cameras.selectedDeviceId,
		deviceId: cameras.selectedDeviceId || undefined,
	});
	useEffect(() => {
		let active = true;
		let revision = 0;
		const unsubscribe = window.electronAPI.onCameraPreviewState?.((next) => {
			revision++;
			if (active) setState(next);
		});
		// Subscribe first, and never overwrite an event with an older invoke response.
		const initialRevision = revision;
		void window.electronAPI.getCameraPreviewState?.().then((next) => {
			if (active && next && initialRevision === revision) setState(next);
		});
		return () => {
			active = false;
			unsubscribe?.();
		};
	}, []);
	useEffect(() => {
		const element = video.current;
		if (!element) return;
		element.srcObject = stream;
		return () => {
			element.srcObject = null;
		};
	}, [stream]);
	const end = () => {
		if (!dragging.current) return;
		dragging.current = false;
		setAdjusting(false);
		void window.electronAPI.transformCameraPreview?.({ action: "end" });
	};
	const begin = (event: PointerEvent<HTMLElement>, direction: CameraPreviewTransform) => {
		if (event.button !== 0) return;
		event.preventDefault();
		dragging.current = true;
		setAdjusting(true);
		event.currentTarget.setPointerCapture(event.pointerId);
		void window.electronAPI.transformCameraPreview?.({ action: "begin", direction });
	};
	const nudge = (event: KeyboardEvent<HTMLButtonElement>, direction: CameraPreviewTransform) => {
		const step = event.shiftKey ? 20 : 5;
		const deltas: Record<string, [number, number]> = {
			ArrowLeft: [-step, 0],
			ArrowRight: [step, 0],
			ArrowUp: [0, -step],
			ArrowDown: [0, step],
		};
		const delta = deltas[event.key];
		if (!delta) return;
		event.preventDefault();
		void window.electronAPI.transformCameraPreview?.({
			action: "nudge",
			direction,
			dx: delta[0],
			dy: delta[1],
		});
	};
	return (
		<div className={styles.shell}>
			<section
				className={`${styles.camera} ${adjusting ? styles.adjusting : ""}`}
				aria-label={t("preview.name")}
				onPointerMove={() => {
					if (dragging.current)
						void window.electronAPI.transformCameraPreview?.({ action: "update" });
				}}
				onPointerUp={end}
				onPointerCancel={end}
				onLostPointerCapture={end}
			>
				<div className={styles.picture}>
					<video ref={video} autoPlay muted playsInline aria-label={t("preview.name")} />
					{!stream && (
						<div role="status" className={styles.message}>
							{error ||
							cameras.error ||
							(state.enabled && cameras.isReady && !cameras.selectedDeviceId)
								? t("webcam.unavailable")
								: t("webcam.searching")}
						</div>
					)}
				</div>
				<button
					type="button"
					className={styles.surface}
					aria-label={t("preview.move")}
					onPointerDown={(event) => begin(event, "move")}
					onKeyDown={(event) => nudge(event, "move")}
				/>
				<div className={styles.controls}>
					<button
						type="button"
						className={styles.move}
						aria-label={t("preview.move")}
						title={t("preview.move")}
						onPointerDown={(event) => begin(event, "move")}
						onKeyDown={(event) => nudge(event, "move")}
					>
						<GripHorizontal size={16} />
					</button>
					<button
						type="button"
						className={styles.hide}
						aria-label={t("preview.hide")}
						title={t("preview.hide")}
						onClick={() => {
							void window.electronAPI.hideCameraPreview?.();
						}}
					>
						<X size={14} />
					</button>
				</div>
				{corners.map((corner) => (
					<button
						key={corner}
						type="button"
						className={`${styles.corner} ${styles[corner]}`}
						aria-label={t(`preview.${corner}`)}
						onPointerDown={(event) => begin(event, corner)}
						onKeyDown={(event) => nudge(event, corner)}
					/>
				))}
			</section>
		</div>
	);
}
