import { Check, X } from "lucide-react";
import { type CSSProperties, memo, useEffect, useRef } from "react";
import { useAudioLevelMeter } from "../../hooks/useAudioLevelMeter";
import type { CameraDevice } from "../../hooks/useCameraDevices";
import type { CameraPreviewShape } from "../../hooks/useCameraLook";
import { useCameraPreviewStream } from "../../hooks/useCameraPreviewStream";
import type { MicrophoneDevice } from "../../hooks/useMicrophoneDevices";
import { WEBCAM_QUALITY_IDS, type WebcamQualityId } from "../../hooks/webcamCaptureTarget";
import { Tooltip } from "../ui/tooltip";
import styles from "./LaunchWindow.module.css";

/** Default first: the whole frame is what the preview is for, checking framing (#1288). */
const CAMERA_SHAPES: readonly CameraPreviewShape[] = ["default", "square"];

const LEVEL_SEGMENTS = 12;
const LEVEL_SEGMENT_KEYS = Array.from({ length: LEVEL_SEGMENTS }, (_, i) => `segment-${i}`);

export interface HudDeviceSettingsLabels {
	title: string;
	close: string;
	microphone: string;
	camera: string;
	micLevel: string;
	micHint: string;
	noMicrophones: string;
	searching: string;
	noCameras: string;
	cameraUnavailable: string;
	preview: string;
	previewUnavailable: string;
	about: string;
	checkForUpdates: string;
	checkingForUpdates: string;
	cameraQuality: string;
	cameraQualityOptions: Record<WebcamQualityId, string>;
	cameraShape: string;
	cameraShapeOptions: Record<CameraPreviewShape, string>;
	cameraRoundness: string;
}

/** Segmented input-level bar, driven by the live analyser. */
const LevelMeter = memo(function LevelMeter({ level }: { level: number }) {
	const lit = Math.round((Math.min(100, Math.max(0, level)) / 100) * LEVEL_SEGMENTS);
	return (
		<div className={styles.levelMeter} role="meter" aria-valuenow={Math.round(level)}>
			{LEVEL_SEGMENT_KEYS.map((key, index) => (
				<span
					key={key}
					className={`${styles.levelSegment} ${index < lit ? styles.levelSegmentOn : ""}`}
				/>
			))}
		</div>
	);
});

function CameraPreview({
	stream,
	error,
	unavailableLabel,
}: {
	stream: MediaStream | null;
	error: string | null;
	unavailableLabel: string;
}) {
	const videoRef = useRef<HTMLVideoElement | null>(null);

	useEffect(() => {
		const video = videoRef.current;
		if (!video) return;
		video.srcObject = stream;
		return () => {
			video.srcObject = null;
		};
	}, [stream]);

	if (error || !stream) {
		return (
			<div className={styles.cameraPreview}>
				<span className={styles.cameraPreviewFallback}>{error ? unavailableLabel : ""}</span>
			</div>
		);
	}

	// No <track>: this is a live self-view with no audio and nothing to caption.
	return <video ref={videoRef} className={styles.cameraPreview} autoPlay muted playsInline />;
}

/**
 * Device selection *and* verification in one place.
 *
 * Picking a device here never turns anything on: the HUD's mic and camera
 * buttons are plain on/off toggles that use whatever is selected here, which is
 * what separates "choose my hardware" from "start capturing it". While this
 * panel is open it holds its own preview stream and analyser so the user can
 * confirm the device actually works before recording — those are torn down with
 * the panel and are entirely separate from the recorder's capture streams.
 */
export const HudDeviceSettings = memo(function HudDeviceSettings({
	showMicrophone,
	micDevices,
	cameraDevices,
	activeMicId,
	activeCameraId,
	cameraLoading,
	cameraError,
	labels,
	versionLabel,
	canCheckForUpdates,
	checkingForUpdates,
	cameraQuality,
	onSelectCameraQuality,
	cameraShape,
	onSelectCameraShape,
	cameraRoundness,
	onChangeCameraRoundness,
	onSelectMic,
	onSelectCamera,
	onCheckForUpdates,
	onClose,
	panelRef,
}: {
	/** False where a take cannot record the microphone (see `canRecordMicrophone`). */
	showMicrophone: boolean;
	micDevices: MicrophoneDevice[];
	cameraDevices: CameraDevice[];
	activeMicId: string | undefined;
	activeCameraId: string | undefined;
	cameraLoading: boolean;
	cameraError: string | null;
	labels: HudDeviceSettingsLabels;
	/** Already interpolated ("Version 1.9.6"), or null while the main process has not
	 *  answered — the About block stays out rather than reading "Version undefined". */
	versionLabel: string | null;
	canCheckForUpdates: boolean;
	checkingForUpdates: boolean;
	cameraQuality: WebcamQualityId;
	onSelectCameraQuality: (quality: WebcamQualityId) => void;
	/** Default shows the camera's whole frame; Custom crops it square, rounded, and a fresh take with it. */
	cameraShape: CameraPreviewShape;
	onSelectCameraShape: (shape: CameraPreviewShape) => void;
	/** The Custom (square) preview's rounding, 0 square to 1 round. Offered only once Custom is picked. */
	cameraRoundness: number;
	onChangeCameraRoundness: (roundness: number) => void;
	onSelectMic: (device: MicrophoneDevice) => void;
	onSelectCamera: (device: CameraDevice) => void;
	onCheckForUpdates: () => void;
	onClose: () => void;
	panelRef: (el: HTMLDivElement | null) => void;
}) {
	// Only reach for hardware that is actually there — otherwise opening the panel
	// on a machine with no webcam fires a getUserMedia that can only fail.
	const hasCamera = cameraDevices.length > 0 && !cameraError && !cameraLoading;
	const { level } = useAudioLevelMeter({
		enabled: showMicrophone && micDevices.length > 0,
		deviceId: activeMicId && activeMicId !== "default" ? activeMicId : undefined,
	});
	const roundnessPercent = Math.round(cameraRoundness * 100);
	const { stream, error: previewError } = useCameraPreviewStream({
		enabled: hasCamera,
		deviceId: activeCameraId,
	});

	return (
		<div
			ref={panelRef}
			data-hud-interactive="true"
			data-testid="hud-device-settings"
			role="dialog"
			aria-label={labels.title}
			className={`${styles.hudModal} ${styles.hudScrollbar} animate-mic-panel-in ${styles.electronNoDrag}`}
		>
			<div className={styles.hudModalHeader}>
				<span className={styles.hudModalTitle}>{labels.title}</span>
				{/* Beside the X, not above it: the panel is the tallest thing the window reserves
				    room for, so there may be little left over its header. */}
				<Tooltip content={labels.close} side="left">
					<button
						type="button"
						aria-label={labels.close}
						onClick={onClose}
						className={styles.hudModalClose}
					>
						<X size={16} />
					</button>
				</Tooltip>
			</div>

			{showMicrophone ? (
				<>
					<div className={styles.hudMenuSectionLabel}>{labels.microphone}</div>
					{micDevices.length === 0 ? (
						<div className={styles.hudModalEmpty}>{labels.noMicrophones}</div>
					) : (
						micDevices.map((device) => {
							const isActive = device.deviceId === activeMicId;
							return (
								<button
									key={device.deviceId}
									type="button"
									role="menuitemradio"
									aria-checked={isActive}
									onClick={() => onSelectMic(device)}
									className={`${styles.languageMenuItem} ${isActive ? styles.languageMenuItemActive : ""}`}
								>
									<span className="truncate">{device.label}</span>
									{isActive ? <Check size={14} className="text-white/85" /> : null}
								</button>
							);
						})
					)}
					<div className={styles.hudModalMeterRow}>
						<span className={styles.hudModalMeterLabel}>{labels.micLevel}</span>
						<LevelMeter level={level} />
					</div>
					<div className={styles.hudModalHint}>{labels.micHint}</div>
				</>
			) : null}

			<div className={styles.hudMenuSectionLabel}>{labels.camera}</div>
			{cameraLoading ? (
				<div className={styles.hudModalEmpty}>{labels.searching}</div>
			) : cameraError ? (
				<div className={styles.hudModalEmpty}>{labels.cameraUnavailable}</div>
			) : cameraDevices.length === 0 ? (
				<div className={styles.hudModalEmpty}>{labels.noCameras}</div>
			) : (
				cameraDevices.map((device) => {
					const isActive = device.deviceId === activeCameraId;
					return (
						<button
							key={device.deviceId}
							type="button"
							role="menuitemradio"
							aria-checked={isActive}
							onClick={() => onSelectCamera(device)}
							className={`${styles.languageMenuItem} ${isActive ? styles.languageMenuItemActive : ""}`}
						>
							<span className="truncate">{device.label}</span>
							{isActive ? <Check size={14} className="text-white/85" /> : null}
						</button>
					);
				})
			)}
			{hasCamera ? (
				<>
					{/* Below the device list, because it qualifies the camera picked
					    above. Hidden with no camera present -- a resolution control
					    over "No camera found" cannot do anything. */}
					<div className={styles.hudModalMeterRow}>
						<span className={styles.hudModalMeterLabel}>{labels.cameraQuality}</span>
					</div>
					{WEBCAM_QUALITY_IDS.map((quality) => {
						const isActive = quality === cameraQuality;
						return (
							<button
								key={quality}
								type="button"
								role="menuitemradio"
								aria-checked={isActive}
								data-testid={`camera-quality-${quality}`}
								onClick={() => onSelectCameraQuality(quality)}
								className={`${styles.languageMenuItem} ${isActive ? styles.languageMenuItemActive : ""}`}
							>
								<span className="truncate">{labels.cameraQualityOptions[quality]}</span>
								{isActive ? <Check size={11} className="text-white/85" /> : null}
							</button>
						);
					})}
					<div className={styles.hudModalMeterRow}>
						<span className={styles.hudModalMeterLabel}>{labels.cameraShape}</span>
					</div>
					{CAMERA_SHAPES.map((shape) => {
						const isActive = shape === cameraShape;
						return (
							<button
								key={shape}
								type="button"
								role="menuitemradio"
								aria-checked={isActive}
								data-testid={`camera-shape-${shape}`}
								onClick={() => onSelectCameraShape(shape)}
								className={`${styles.languageMenuItem} ${isActive ? styles.languageMenuItemActive : ""}`}
							>
								<span className="truncate">{labels.cameraShapeOptions[shape]}</span>
								{isActive ? <Check size={11} className="text-white/85" /> : null}
							</button>
						);
					})}
					{cameraShape === "square" ? (
						<div className={styles.hudSlider}>
							<div className={styles.hudSliderHead}>
								<label htmlFor="hud-camera-roundness" className={styles.hudModalMeterLabel}>
									{labels.cameraRoundness}
								</label>
								<span className={styles.hudSliderValue}>{roundnessPercent}%</span>
							</div>
							{/* Drawn like the editor's sliders (SliderCell): a pill track filled up to the
							    value, and a white knob. */}
							<input
								id="hud-camera-roundness"
								type="range"
								min={0}
								max={100}
								step={5}
								value={roundnessPercent}
								data-testid="camera-roundness"
								style={{ "--slider-pct": `${roundnessPercent}%` } as CSSProperties}
								onChange={(event) => onChangeCameraRoundness(Number(event.target.value) / 100)}
								className={styles.hudSliderInput}
							/>
						</div>
					) : null}
					<div className={styles.hudModalMeterRow}>
						<span className={styles.hudModalMeterLabel}>{labels.preview}</span>
					</div>
					<CameraPreview
						stream={stream}
						error={previewError}
						unavailableLabel={labels.previewUnavailable}
					/>
				</>
			) : null}

			{/* The HUD has no other settings surface, and an app the user cannot ask "which
			    version am I running?" is an app whose bug reports arrive without one. The
			    update button is absent — not disabled — where a package manager owns the
			    update; see electron/install-channel.ts. */}
			{versionLabel ? (
				<>
					<div className={styles.hudMenuSectionLabel}>{labels.about}</div>
					<div className={styles.hudModalAboutRow}>
						<span className={styles.hudModalVersion}>{versionLabel}</span>
						{canCheckForUpdates ? (
							<button
								type="button"
								data-testid="hud-check-for-updates"
								onClick={onCheckForUpdates}
								disabled={checkingForUpdates}
								className={styles.hudModalAboutAction}
							>
								{checkingForUpdates ? labels.checkingForUpdates : labels.checkForUpdates}
							</button>
						) : null}
					</div>
				</>
			) : null}
		</div>
	);
});
