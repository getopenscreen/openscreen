// Hidden-window runner for `openscreen record`. Reuses the full recording
// pipeline via useScreenRecorder (native macOS/Windows helpers with browser
// fallback), driven by the CLI controller instead of the HUD.

import { useEffect, useRef, useState } from "react";
import {
	normalizeProjectEditor,
	PROJECT_VERSION,
} from "@/components/video-editor/projectPersistence";
import { useScreenRecorder } from "@/hooks/useScreenRecorder";
import type { CliRecordRequest } from "@/lib/cliContracts";
import { pickRecordingSource } from "@/lib/cliSourcePick";
import { portalOwnsSourceSelection } from "@/lib/nativeLinuxRecording";
import { DEFAULT_PROJECT_APPEARANCE } from "@/lib/projectDefaults";

type Phase = "init" | "recording" | "stopping" | "done";

async function pickSource(request: CliRecordRequest): Promise<ProcessedDesktopSource> {
	const sources = await window.electronAPI.getSources({
		types: ["screen", "window"],
		thumbnailSize: { width: 32, height: 18 },
	});

	return pickRecordingSource(sources, request);
}

/** The microphone or camera whose label contains `deviceNameFilter`; none asked = the default. */
async function resolveDeviceId(
	kind: "audioinput" | "videoinput",
	deviceNameFilter: string | null,
): Promise<{
	deviceId: string | undefined;
	deviceName: string | undefined;
}> {
	if (!deviceNameFilter) return { deviceId: undefined, deviceName: undefined };

	// Labels require an active permission grant; a short-lived stream unlocks them.
	let probeStream: MediaStream | null = null;
	try {
		probeStream = await navigator.mediaDevices.getUserMedia(
			kind === "audioinput" ? { audio: true } : { video: true },
		);
	} catch {
		// Enumeration below may still work with empty labels.
	}
	try {
		const devices = await navigator.mediaDevices.enumerateDevices();
		const needle = deviceNameFilter.toLowerCase();
		const match = devices.find(
			(device) => device.kind === kind && device.label.toLowerCase().includes(needle),
		);
		if (!match) {
			const labels = devices
				.filter((d) => d.kind === kind && d.label)
				.map((d) => `  - ${d.label}`)
				.join("\n");
			const what = kind === "audioinput" ? "microphone" : "camera";
			throw new Error(`No ${what} label contains "${deviceNameFilter}". Devices:\n${labels}`);
		}
		return { deviceId: match.deviceId, deviceName: match.label };
	} finally {
		probeStream?.getTracks().forEach((track) => track.stop());
	}
}

/**
 * The camera the user picked in OpenScreen, while it is still connected: what `camera` with no
 * name records. A system has no default camera, and the first one listed is often a virtual
 * camera that delivers nothing. With none picked, or the picked one gone, the default.
 */
async function usersCamera(): Promise<{
	deviceId: string | undefined;
	deviceName: string | undefined;
}> {
	const prefs = await window.electronAPI.getRecordingPrefs?.().catch(() => null);
	const id = prefs?.camDeviceId;
	const name = prefs?.camDeviceName;
	if (!id && !name) return { deviceId: undefined, deviceName: undefined };
	// Ids are listed without a permission grant, labels only with one: the id comes first.
	const cameras = (await navigator.mediaDevices.enumerateDevices()).filter(
		(device) => device.kind === "videoinput",
	);
	const match =
		cameras.find((device) => id && device.deviceId === id) ??
		cameras.find((device) => name && device.label === name);
	return match
		? { deviceId: match.deviceId, deviceName: match.label || name || undefined }
		: { deviceId: undefined, deviceName: undefined };
}

/** A minimal .openscreen project referencing the finished recording, with all
 * editor settings at their defaults — ready for `openscreen export` or the GUI. */
function buildDefaultProject(session: {
	screenVideoPath: string;
	webcamVideoPath?: string;
	webcamOffsetMs?: number;
	cursorCaptureMode?: string;
}) {
	return {
		version: PROJECT_VERSION,
		media: {
			screenVideoPath: session.screenVideoPath,
			...(session.webcamVideoPath ? { webcamVideoPath: session.webcamVideoPath } : {}),
			...(session.webcamVideoPath && session.webcamOffsetMs !== undefined
				? { webcamOffsetMs: session.webcamOffsetMs }
				: {}),
			...(session.cursorCaptureMode ? { cursorCaptureMode: session.cursorCaptureMode } : {}),
		},
		// A new project: it takes the current default format rather than the v2 reading of none.
		editor: normalizeProjectEditor({ aspectRatio: DEFAULT_PROJECT_APPEARANCE.aspectRatio }),
	};
}

/** Advice the caller can act on, for the one failure that names a cursor limitation. The
 * matched wording is the PipeWire helper's, typed and stable, so it cannot misfire. */
function withCursorRetryHint(message: string): string {
	return /advertise METADATA cursor mode/.test(message)
		? `${message} Retry with "cursor": "system" to record with the system cursor baked in.`
		: message;
}

export function CliRecordRunner() {
	const recorder = useScreenRecorder();
	const startedRef = useRef(false);
	const requestRef = useRef<CliRecordRequest | null>(null);
	// Re-render trigger once the bootstrap has applied all recorder settings;
	// the start effect below cannot rely on recorder state deps alone because
	// default-valued settings (no mic, no system audio) never change.
	const [requestReady, setRequestReady] = useState<CliRecordRequest | null>(null);
	const phaseRef = useRef<Phase>("init");
	const recordingStartedAtRef = useRef<number | null>(null);
	// A stop (SIGINT/stdin) can land while the capture helper is still starting;
	// remember it and apply as soon as recording flips on.
	const stopRequestedRef = useRef(false);
	const [status, setStatus] = useState("Preparing recording…");

	const {
		recording,
		saving,
		startRecordingImmediately,
		toggleRecording,
		setMicrophoneEnabled,
		setMicrophoneDeviceId,
		setMicrophoneDeviceName,
		setSystemAudioEnabled,
		setCursorCaptureMode,
		setWebcamEnabled,
		setWebcamDeviceId,
		setWebcamDeviceName,
		recordingPrefsLoaded,
	} = recorder;

	// Keep latest values in refs for the stop/finish effects.
	const toggleRecordingRef = useRef(toggleRecording);
	const recordingRef = useRef(recording);
	useEffect(() => {
		toggleRecordingRef.current = toggleRecording;
		recordingRef.current = recording;
	});

	const fail = async (error: unknown) => {
		phaseRef.current = "done";
		const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
		await window.electronAPI.cliDone({ success: false, error: message });
	};

	// Bootstrap: pick source, configure recorder, start.
	// Wait for persisted GUI prefs to land first, then overwrite every field
	// from the CLI request so a previous HUD session cannot enable mic/webcam.
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional run-once bootstrap; startedRef guards re-entry
	useEffect(() => {
		if (startedRef.current || !recordingPrefsLoaded) return;
		startedRef.current = true;

		void (async () => {
			try {
				// The recorder hook surfaces some failures via blocking alert(); a
				// hidden window must never show (or hang on) a modal.
				window.alert = (message?: unknown) => {
					window.electronAPI.cliLog("error", `Recorder: ${String(message)}`);
				};

				const request = (await window.electronAPI.cliGetRequest()) as CliRecordRequest;
				if (request.kind !== "record") {
					throw new Error(`cli-record window received a ${request.kind} request`);
				}
				requestRef.current = request;

				// The native Linux helper asks the portal to choose a source. Enumerating
				// Chromium sources first opens a redundant picker and can return no screens.
				if (await portalOwnsSourceSelection(window.electronAPI)) {
					window.electronAPI.cliLog(
						"info",
						"Recording source: chosen in the system picker (--display and --window do not apply)",
					);
				} else {
					const source = await pickSource(request);
					const selected = await window.electronAPI.selectSource(source, { persist: false });
					if (!selected) {
						throw new Error(
							`Recording source "${source.name}" (${source.id}) is no longer available. ` +
								"Re-list sources with `openscreen sources` and pick one that is currently shared.",
						);
					}
					window.electronAPI.cliLog("info", `Recording source: ${selected.name}`);
				}

				setMicrophoneEnabled(Boolean(request.mic));
				if (request.mic) {
					const mic = await resolveDeviceId("audioinput", request.micDevice);
					setMicrophoneDeviceId(mic.deviceId);
					setMicrophoneDeviceName(mic.deviceName);
					if (mic.deviceName) {
						window.electronAPI.cliLog("info", `Microphone: ${mic.deviceName}`);
					}
				} else {
					setMicrophoneDeviceId(undefined);
					setMicrophoneDeviceName(undefined);
				}
				if (request.camera) {
					const camera = request.cameraDevice
						? await resolveDeviceId("videoinput", request.cameraDevice)
						: await usersCamera();
					setWebcamDeviceId(camera.deviceId);
					setWebcamDeviceName(camera.deviceName);
					// The HUD's own check: access granted, and a camera to open.
					if (!(await setWebcamEnabled(true))) {
						throw new Error(
							"The camera could not be turned on: camera access is denied, or no camera is connected",
						);
					}
					if (camera.deviceName) {
						window.electronAPI.cliLog("info", `Camera: ${camera.deviceName}`);
					}
				} else {
					await setWebcamEnabled(false);
					setWebcamDeviceId(undefined);
					setWebcamDeviceName(undefined);
				}
				setSystemAudioEnabled(request.systemAudio);
				setCursorCaptureMode(request.cursorMode);
				setStatus("Starting recording…");
				setRequestReady(request);
			} catch (error) {
				await fail(error);
			}
		})();
	}, [recordingPrefsLoaded]);

	// The setters above land on the *next* render; start only once they have.
	const configuredRef = useRef(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: fires when recorder settings match the request; other referenced values are stable refs/callbacks
	useEffect(() => {
		const request = requestReady;
		if (!request || configuredRef.current || phaseRef.current !== "init") return;
		const micReady = recorder.microphoneEnabled === Boolean(request.mic);
		const webcamReady = recorder.webcamEnabled === Boolean(request.camera);
		const systemAudioReady = recorder.systemAudioEnabled === request.systemAudio;
		const cursorReady = recorder.cursorCaptureMode === request.cursorMode;
		if (!micReady || !webcamReady || !systemAudioReady || !cursorReady) return;

		configuredRef.current = true;
		phaseRef.current = "recording";
		void (async () => {
			try {
				const outcome = await startRecordingImmediately();
				// The recorder already knows why: report its reason now, not a guessing deadline.
				if (outcome.kind !== "started") {
					// The camera effect may have failed the run already (#1303); its error won.
					if (phaseRef.current !== "recording") return;
					await fail(
						outcome.kind === "cancelled"
							? new Error("The screen-share picker was dismissed")
							: new Error(withCursorRetryHint(outcome.message)),
					);
					return;
				}
				// Started, but `recording` may not have reached this render yet; if it never
				// does, that is a wiring defect, not a slow capture.
				setTimeout(() => {
					if (recordingStartedAtRef.current === null && phaseRef.current === "recording") {
						void fail(
							new Error(
								"The recording start reported success but the recording state never confirmed it",
							),
						);
					}
				}, 30_000);
			} catch (error) {
				await fail(error);
			}
		})();
	}, [
		requestReady,
		recorder.microphoneEnabled,
		recorder.webcamEnabled,
		recorder.systemAudioEnabled,
		recorder.cursorCaptureMode,
	]);

	// A camera that cannot be opened (held by another app, OpenScreen's own HUD among them on
	// Linux, or unplugged) turns itself back off in the recorder, which then records without it.
	// A take asked to have the camera fails instead of reporting success without it (#1303).
	// biome-ignore lint/correctness/useExhaustiveDependencies: fail is stable
	useEffect(() => {
		if (!requestReady?.camera || recorder.webcamEnabled) return;
		if (phaseRef.current === "done" || recordingStartedAtRef.current !== null) return;
		void fail(
			new Error(
				"The camera could not be opened: another app is using it (OpenScreen itself, when it is running), or it was disconnected",
			),
		);
	}, [requestReady, recorder.webcamEnabled]);

	// Recording state transitions: report start and arm the duration timer.
	useEffect(() => {
		const request = requestRef.current;
		// The take failed while its capture was starting: stop it, nobody is waiting for it.
		if (recording && phaseRef.current === "done" && recordingStartedAtRef.current === null) {
			toggleRecordingRef.current();
			return;
		}
		if (recording && recordingStartedAtRef.current === null) {
			recordingStartedAtRef.current = Date.now();
			setStatus("Recording…");
			window.electronAPI.cliLog("info", "Recording started");

			if (stopRequestedRef.current) {
				phaseRef.current = "stopping";
				setStatus("Stopping…");
				toggleRecordingRef.current();
				return;
			}

			if (request?.durationMs) {
				const timer = setTimeout(() => {
					if (recordingRef.current && phaseRef.current === "recording") {
						phaseRef.current = "stopping";
						window.electronAPI.cliLog("info", `Duration reached (${request.durationMs}ms)`);
						toggleRecordingRef.current();
					}
				}, request.durationMs);
				return () => clearTimeout(timer);
			}
		}
	}, [recording]);

	// External stop (SIGINT / stdin via main process).
	useEffect(() => {
		return window.electronAPI.onCliStopRecording(() => {
			if (recordingRef.current && phaseRef.current === "recording") {
				phaseRef.current = "stopping";
				setStatus("Stopping…");
				toggleRecordingRef.current();
			} else {
				// Capture is still starting; stop as soon as it comes up.
				stopRequestedRef.current = true;
			}
		});
	}, []);

	// Completion: recording flipped off and the session finished saving.
	// biome-ignore lint/correctness/useExhaustiveDependencies: completion is keyed on recording/saving; fail is stable
	useEffect(() => {
		if (recordingStartedAtRef.current === null) return;
		if (recording || saving) return;
		if (phaseRef.current === "done") return;
		phaseRef.current = "done";

		void (async () => {
			try {
				const sessionResult = await window.electronAPI.getCurrentRecordingSession();
				const session = sessionResult?.session;
				if (!session?.screenVideoPath) {
					throw new Error("Recording finished but no session manifest was stored");
				}
				const durationMs = Date.now() - (recordingStartedAtRef.current ?? Date.now());
				const request = requestRef.current;
				await window.electronAPI.cliDone({
					success: true,
					screenVideoPath: session.screenVideoPath,
					webcamVideoPath: session.webcamVideoPath,
					webcamOffsetMs: session.webcamOffsetMs,
					cursorDataPath: `${session.screenVideoPath}.cursor.json`,
					durationMs,
					...(request?.projectOut ? { projectData: buildDefaultProject(session) } : {}),
					// The take ended before it was stopped but was kept: a script must be
					// able to tell that apart from a clean run.
					...(sessionResult.warning ? { warnings: [sessionResult.warning] } : {}),
				});
			} catch (error) {
				await fail(error);
			}
		})();
	}, [recording, saving]);

	return (
		<div className="flex h-screen items-center justify-center bg-[#09090b] text-white/60 text-sm">
			{status}
		</div>
	);
}

export default CliRecordRunner;
