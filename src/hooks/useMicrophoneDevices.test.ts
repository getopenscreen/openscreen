// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isPlaceholderMicrophoneLabel, useMicrophoneDevices } from "./useMicrophoneDevices";

const DEVICES = [
	{ kind: "audioinput", deviceId: "mic-a", label: "Realtek Array Microphone", groupId: "g1" },
	{ kind: "audioinput", deviceId: "mic-b", label: "Microphone (Logitech PRO X)", groupId: "g2" },
	{ kind: "videoinput", deviceId: "cam", label: "Webcam", groupId: "g3" },
];

const enumerateDevices = vi.fn(async () => DEVICES);
const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] }));
const addEventListener = vi.fn();
const removeEventListener = vi.fn();

Object.defineProperty(global.navigator, "mediaDevices", {
	value: {
		enumerateDevices,
		getUserMedia,
		addEventListener,
		removeEventListener,
	},
	configurable: true,
});

describe("useMicrophoneDevices", () => {
	it("recognizes the synthetic label used when permission hid the real name", () => {
		expect(isPlaceholderMicrophoneLabel("Microphone mic-hidd", "mic-hidden")).toBe(true);
		expect(isPlaceholderMicrophoneLabel("Realtek Array Microphone", "mic-a")).toBe(false);
	});

	beforeEach(() => {
		vi.clearAllMocks();
		enumerateDevices.mockResolvedValue(DEVICES);
		getUserMedia.mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] });
	});

	it("falls back to the first input when nothing is remembered", async () => {
		const { result } = renderHook(() => useMicrophoneDevices(true));
		await waitFor(() => expect(result.current.selectedDeviceId).toBe("mic-a"));
		expect(getUserMedia).not.toHaveBeenCalled();
	});

	it("clears the live selection when the remembered microphone is reset", async () => {
		const { result, rerender } = renderHook<
			ReturnType<typeof useMicrophoneDevices>,
			{ preferredId?: string; preferredName?: string }
		>(({ preferredId, preferredName }) => useMicrophoneDevices(true, preferredId, preferredName), {
			initialProps: { preferredId: "mic-b", preferredName: "Microphone (Logitech PRO X)" },
		});
		await waitFor(() => expect(result.current.selectedDeviceId).toBe("mic-b"));

		rerender({});
		await waitFor(() => expect(result.current.selectedDeviceId).toBe("default"));
	});

	it("prefers the remembered microphone over the first input", async () => {
		const { result } = renderHook(() => useMicrophoneDevices(true, "mic-b"));
		await waitFor(() => expect(result.current.selectedDeviceId).toBe("mic-b"));
	});

	/**
	 * Chromium's device ids are per-origin salted, so the id one window persisted
	 * can name nothing in the next while the microphone itself is right there in
	 * the list. Falling through to the first input would silently swap the user's
	 * microphone — which is the bug, one layer down.
	 */
	it("finds the remembered microphone by label when its id no longer matches", async () => {
		const { result } = renderHook(() =>
			useMicrophoneDevices(true, "stale-id", "Microphone (Logitech PRO X)"),
		);
		await waitFor(() => expect(result.current.selectedDeviceId).toBe("mic-b"));
	});

	it("still falls back to the first input when neither id nor label matches", async () => {
		const { result } = renderHook(() =>
			useMicrophoneDevices(true, "stale-id", "A microphone that left"),
		);
		await waitFor(() => expect(result.current.selectedDeviceId).toBe("mic-a"));
	});

	it("does not guess when a saved microphone label matches more than one device", async () => {
		enumerateDevices.mockResolvedValueOnce([
			{ kind: "audioinput", deviceId: "mic-a", label: "USB microphone", groupId: "g1" },
			{ kind: "audioinput", deviceId: "mic-b", label: "USB microphone", groupId: "g2" },
		]);
		const { result } = renderHook(() => useMicrophoneDevices(true, "stale-id", "USB microphone"));
		await waitFor(() => expect(result.current.selectedDeviceId).toBe("mic-a"));
	});

	it("probes only when labels are hidden, re-enumerates, and always stops the probe", async () => {
		const stop = vi.fn();
		enumerateDevices
			.mockResolvedValueOnce([{ kind: "audioinput", deviceId: "mic-a", label: "", groupId: "g1" }])
			.mockResolvedValueOnce(DEVICES);
		getUserMedia.mockResolvedValueOnce({ getTracks: () => [{ stop }] });

		const { result } = renderHook(() => useMicrophoneDevices(true));
		await waitFor(() => expect(result.current.devices[0]?.label).toBe("Realtek Array Microphone"));
		expect(getUserMedia).toHaveBeenCalledTimes(1);
		expect(enumerateDevices).toHaveBeenCalledTimes(2);
		expect(stop).toHaveBeenCalledTimes(1);
	});

	it("keeps the first live list when the label probe is rejected", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		enumerateDevices.mockResolvedValueOnce([
			{ kind: "audioinput", deviceId: "mic-hidden", label: "", groupId: "g1" },
		]);
		getUserMedia.mockRejectedValueOnce(new Error("probe busy"));

		const { result } = renderHook(() => useMicrophoneDevices(true));
		await waitFor(() => expect(result.current.isReady).toBe(true));
		expect(result.current.devices).toEqual([
			{ deviceId: "mic-hidden", label: "Microphone mic-hidd", groupId: "g1" },
		]);
		expect(result.current.error).toBeNull();
		warn.mockRestore();
	});

	it("stops the probe and keeps the first list when the label refresh fails", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const stop = vi.fn();
		enumerateDevices
			.mockResolvedValueOnce([
				{ kind: "audioinput", deviceId: "mic-hidden", label: "", groupId: "g1" },
			])
			.mockRejectedValueOnce(new Error("refresh failed"));
		getUserMedia.mockResolvedValueOnce({ getTracks: () => [{ stop }] });

		const { result } = renderHook(() => useMicrophoneDevices(true));
		await waitFor(() => expect(result.current.isReady).toBe(true));
		expect(result.current.devices).toHaveLength(1);
		expect(stop).toHaveBeenCalledTimes(1);
		warn.mockRestore();
	});

	it("binds readiness to the current enable generation and retries after off then on", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		let resolveRetry: ((devices: typeof DEVICES) => void) | undefined;
		enumerateDevices.mockRejectedValueOnce(new Error("transient enumeration failure"));
		enumerateDevices.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveRetry = resolve;
				}),
		);
		const { result, rerender } = renderHook(
			({ enabled }: { enabled: boolean }) => useMicrophoneDevices(enabled, "mic-b"),
			{ initialProps: { enabled: true } },
		);
		await waitFor(() => expect(result.current.error).toBe("transient enumeration failure"));
		expect(result.current.devices).toEqual([]);

		rerender({ enabled: false });
		expect(result.current.isReady).toBe(true);
		await act(async () => rerender({ enabled: true }));
		expect(result.current.isReady).toBe(false);
		await act(async () => resolveRetry?.(DEVICES));
		await waitFor(() => expect(result.current.selectedDeviceId).toBe("mic-b"));
		expect(result.current.isReady).toBe(true);
		expect(enumerateDevices).toHaveBeenCalledTimes(2);
		error.mockRestore();
	});

	it("keeps an older devicechange result stale until the newest load completes", async () => {
		const { result } = renderHook(() => useMicrophoneDevices(true));
		await waitFor(() => expect(result.current.isReady).toBe(true));
		expect(result.current.devices[0]?.deviceId).toBe("mic-a");

		let resolveOlder: ((devices: typeof DEVICES) => void) | undefined;
		let resolveNewest: ((devices: typeof DEVICES) => void) | undefined;
		enumerateDevices
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveOlder = resolve;
					}),
			)
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveNewest = resolve;
					}),
			);
		const onDeviceChange = addEventListener.mock.calls.find(
			([name]) => name === "devicechange",
		)?.[1] as (() => void) | undefined;
		if (!onDeviceChange) throw new Error("devicechange listener was not registered");

		act(() => {
			void onDeviceChange();
		});
		act(() => {
			void onDeviceChange();
		});
		await waitFor(() => expect(enumerateDevices).toHaveBeenCalledTimes(3));
		expect(result.current.isReady).toBe(false);

		await act(async () =>
			resolveOlder?.([
				{ kind: "audioinput", deviceId: "mic-old", label: "Older", groupId: "g-old" },
			]),
		);
		expect(result.current.isReady).toBe(false);
		expect(result.current.devices[0]?.deviceId).toBe("mic-a");

		await act(async () =>
			resolveNewest?.([
				{ kind: "audioinput", deviceId: "mic-new", label: "Newest", groupId: "g-new" },
			]),
		);
		await waitFor(() => expect(result.current.isReady).toBe(true));
		expect(result.current.devices).toEqual([
			{ deviceId: "mic-new", label: "Newest", groupId: "g-new" },
		]);
	});
});
