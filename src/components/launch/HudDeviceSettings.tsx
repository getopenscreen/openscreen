import { Check, FolderOpen, RotateCcw, X } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { useAudioLevelMeter } from "../../hooks/useAudioLevelMeter";
import type { CameraDevice } from "../../hooks/useCameraDevices";
import { useCameraPreviewStream } from "../../hooks/useCameraPreviewStream";
import type { MicrophoneDevice } from "../../hooks/useMicrophoneDevices";
import styles from "./LaunchWindow.module.css";

const LEVEL_SEGMENTS = 12;
const LEVEL_SEGMENT_KEYS = Array.from({ length: LEVEL_SEGMENTS }, (_, i) => `segment-${i}`);

export interface HudDeviceSettingsLabels {
	title: string;
	done: string;
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
	storage: string;
	storageHint: string;
	chooseFolder: string;
	resetToDefault: string;
	changingFolder: string;
	changeFolderFailed: string;
}

/** Where recordings are cached and saved, with folder-picker and reset. */
const RecordingsLocationSetting = memo(function RecordingsLocationSetting({
	labels,
}: {
	labels: HudDeviceSettingsLabels;
}) {
	const [info, setInfo] = useState<{ path: string; isDefault: boolean } | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState(false);

	useEffect(() => {
		let cancelled = false;
		window.electronAPI
			?.getRecordingsDir?.()
			.then((result) => {
				if (!cancelled) setInfo(result);
			})
			.catch(() => {
				// Nothing to show if this fails; the picker still works on demand.
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const handleChoose = async () => {
		setBusy(true);
		setError(false);
		try {
			const result = await window.electronAPI?.chooseRecordingsDir?.();
			if (result?.success) {
				setInfo({ path: result.path, isDefault: false });
			} else if (result && !result.canceled) {
				setError(true);
			}
		} catch {
			setError(true);
		} finally {
			setBusy(false);
		}
	};

	const handleReset = async () => {
		setBusy(true);
		setError(false);
		try {
			const result = await window.electronAPI?.resetRecordingsDir?.();
			if (result?.success) {
				setInfo({ path: result.path, isDefault: true });
			} else {
				setError(true);
			}
		} catch {
			setError(true);
		} finally {
			setBusy(false);
		}
	};

	return (
		<>
			<div className={styles.hudMenuSectionLabel}>{labels.storage}</div>
			<div className={styles.hudModalHint}>{labels.storageHint}</div>
			{info ? (
				<div className={styles.hudStoragePath} title={info.path}>
					{info.path}
				</div>
			) : null}
			<div className={styles.hudStorageActionRow}>
				<button
					type="button"
					className={styles.hudStorageActionButton}
					onClick={handleChoose}
					disabled={busy}
				>
					<FolderOpen size={12} />
					<span className="truncate">{busy ? labels.changingFolder : labels.chooseFolder}</span>
				</button>
				{info && !info.isDefault ? (
					<button
						type="button"
						className={styles.hudStorageActionButton}
						onClick={handleReset}
						disabled={busy}
					>
						<RotateCcw size={12} />
						<span className="truncate">{labels.resetToDefault}</span>
					</button>
				) : null}
			</div>
			{error ? <div className={styles.hudModalHint}>{labels.changeFolderFailed}</div> : null}
		</>
	);
});

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
	onSelectMic,
	onSelectCamera,
	onCheckForUpdates,
	onClose,
	panelRef,
}: {
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
		enabled: micDevices.length > 0,
		deviceId: activeMicId && activeMicId !== "default" ? activeMicId : undefined,
	});
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
				<button
					type="button"
					aria-label={labels.done}
					title={labels.done}
					onClick={onClose}
					className={styles.hudModalClose}
				>
					<X size={14} />
				</button>
			</div>

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
							{isActive ? <Check size={11} className="text-white/85" /> : null}
						</button>
					);
				})
			)}
			<div className={styles.hudModalMeterRow}>
				<span className={styles.hudModalMeterLabel}>{labels.micLevel}</span>
				<LevelMeter level={level} />
			</div>
			<div className={styles.hudModalHint}>{labels.micHint}</div>

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
							{isActive ? <Check size={11} className="text-white/85" /> : null}
						</button>
					);
				})
			)}
			{hasCamera ? (
				<>
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

			<RecordingsLocationSetting labels={labels} />
		</div>
	);
});
