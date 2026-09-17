import { useEffect, useRef, useState } from "react";

export interface MicrophoneDevice {
	deviceId: string;
	label: string;
	groupId: string;
}

export function isPlaceholderMicrophoneLabel(label: string, deviceId: string): boolean {
	return label === `Microphone ${deviceId.slice(0, 8)}`;
}

function microphoneDevices(devices: readonly MediaDeviceInfo[]): MicrophoneDevice[] {
	return devices
		.filter((device) => device.kind === "audioinput")
		.map((device) => ({
			deviceId: device.deviceId,
			label: device.label || `Microphone ${device.deviceId.slice(0, 8)}`,
			groupId: device.groupId,
		}));
}

function resolvePreferredDevice(
	devices: readonly MicrophoneDevice[],
	preferredDeviceId?: string,
	preferredDeviceName?: string,
): MicrophoneDevice | undefined {
	const byId = preferredDeviceId
		? devices.find((device) => device.deviceId === preferredDeviceId)
		: undefined;
	if (byId) return byId;
	const byLabel = preferredDeviceName
		? devices.filter((device) => device.label === preferredDeviceName)
		: [];
	return byLabel.length === 1 ? byLabel[0] : undefined;
}

/**
 * Enumerates live microphone inputs and resolves a stored preference by exact id,
 * then unique label, then the first live input.
 *
 * Enumeration happens before any permission probe. Chromium exposes labels after
 * permission has already been granted, which is the common restart path and needs
 * no temporary stream. If labels are still hidden, a short probe unlocks them and
 * the list is read once more. The first enumeration remains usable when that probe
 * or the second enumeration fails, and every acquired probe stream is stopped in
 * `finally`.
 */
export function useMicrophoneDevices(
	enabled: boolean = true,
	preferredDeviceId?: string,
	preferredDeviceName?: string,
) {
	const [devices, setDevices] = useState<MicrophoneDevice[]>([]);
	const [selectedDeviceId, setSelectedDeviceId] = useState<string>("default");
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// The enabled value identifies the load generation. When false→true renders,
	// the prior disabled "ready" state cannot briefly start a competing meter.
	const [readyGeneration, setReadyGeneration] = useState<boolean | null>(enabled ? null : false);

	const selectedDeviceIdRef = useRef(selectedDeviceId);
	const preferredDeviceIdRef = useRef(preferredDeviceId);
	const preferredDeviceNameRef = useRef(preferredDeviceName);
	const hadPreferenceRef = useRef(false);
	useEffect(() => {
		selectedDeviceIdRef.current = selectedDeviceId;
		preferredDeviceIdRef.current = preferredDeviceId;
		preferredDeviceNameRef.current = preferredDeviceName;
	}, [selectedDeviceId, preferredDeviceId, preferredDeviceName]);

	useEffect(() => {
		if (!enabled) {
			setIsLoading(false);
			setReadyGeneration(false);
			return;
		}

		let mounted = true;
		let latestLoad = 0;
		const loadDevices = async () => {
			if (!mounted) return;
			const loadToken = ++latestLoad;
			const isCurrent = () => mounted && loadToken === latestLoad;
			setIsLoading(true);
			setReadyGeneration(null);
			setError(null);
			let probeStream: MediaStream | null = null;
			try {
				const firstEnumeration = await navigator.mediaDevices.enumerateDevices();
				if (!isCurrent()) return;
				let inputs = microphoneDevices(firstEnumeration);
				const labelsHidden = firstEnumeration.some(
					(device) => device.kind === "audioinput" && !device.label,
				);
				if (labelsHidden) {
					try {
						probeStream = await navigator.mediaDevices.getUserMedia({ audio: true });
						if (!isCurrent()) return;
						try {
							inputs = microphoneDevices(await navigator.mediaDevices.enumerateDevices());
						} catch (secondEnumerationError) {
							if (isCurrent())
								console.warn(
									"Could not refresh microphone labels after permission probe:",
									secondEnumerationError,
								);
						}
					} catch (probeError) {
						if (isCurrent()) console.warn("Could not unlock microphone labels:", probeError);
					}
				}

				if (!isCurrent()) return;
				setDevices(inputs);
				const currentId = selectedDeviceIdRef.current;
				const stillAvailable = inputs.some((device) => device.deviceId === currentId);
				if (currentId === "default" || !stillAvailable) {
					const preferred = resolvePreferredDevice(
						inputs,
						preferredDeviceIdRef.current,
						preferredDeviceNameRef.current,
					);
					setSelectedDeviceId(preferred?.deviceId ?? inputs[0]?.deviceId ?? "default");
				}
			} catch (cause) {
				if (!isCurrent()) return;
				setDevices([]);
				setSelectedDeviceId("default");
				setError(cause instanceof Error ? cause.message : "Failed to enumerate audio devices");
				console.error("Error loading microphone devices:", cause);
			} finally {
				probeStream?.getTracks().forEach((track) => track.stop());
				if (isCurrent()) {
					setIsLoading(false);
					setReadyGeneration(true);
				}
			}
		};

		void loadDevices();
		navigator.mediaDevices.addEventListener("devicechange", loadDevices);
		return () => {
			mounted = false;
			navigator.mediaDevices.removeEventListener("devicechange", loadDevices);
		};
	}, [enabled]);

	useEffect(() => {
		if (!enabled) return;
		const hasPreference = Boolean(preferredDeviceId || preferredDeviceName);
		if (!hasPreference) {
			if (hadPreferenceRef.current) {
				hadPreferenceRef.current = false;
				setSelectedDeviceId("default");
			}
			return;
		}
		hadPreferenceRef.current = true;
		const preferred = resolvePreferredDevice(devices, preferredDeviceId, preferredDeviceName);
		if (!preferred || preferred.deviceId === selectedDeviceId) return;
		setSelectedDeviceId(preferred.deviceId);
	}, [enabled, preferredDeviceId, preferredDeviceName, devices, selectedDeviceId]);

	const resolvedPreference = resolvePreferredDevice(
		devices,
		preferredDeviceId,
		preferredDeviceName,
	);
	const generationReady = enabled ? readyGeneration === true : readyGeneration === false;
	const selectionReady =
		generationReady && (!resolvedPreference || resolvedPreference.deviceId === selectedDeviceId);

	return {
		devices,
		selectedDeviceId,
		setSelectedDeviceId,
		isLoading,
		isReady: selectionReady,
		error,
	};
}
