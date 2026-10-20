// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddAudioLayerDialog } from "./AddAudioLayerDialog";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: () => (key: string) => key,
	useI18n: () => ({ locale: "en", setLocale: () => undefined }),
}));

const addAudioAsset = vi.fn();
vi.mock("@/lib/ai-edition/store/projectStore", () => ({
	useProjectStore: {
		getState: () => ({ document: { assets: [] }, addAudioAsset }),
	},
}));

vi.mock("@/lib/ai-edition/timeline/duration", () => ({
	probeAudioDuration: vi.fn(async () => 3),
}));

/** A MediaRecorder stand-in that records whether it was ever stopped. */
class FakeRecorder {
	static instances: FakeRecorder[] = [];
	state: "inactive" | "recording" = "inactive";
	started = false;
	stopped = false;
	ondataavailable: ((e: { data: Blob }) => void) | null = null;
	onstop: (() => void) | null = null;
	mimeType = "audio/webm";
	constructor() {
		FakeRecorder.instances.push(this);
	}
	static isTypeSupported() {
		return true;
	}
	start() {
		this.started = true;
		this.state = "recording";
	}
	stop() {
		this.stopped = true;
		this.state = "inactive";
		this.onstop?.();
	}
}

const stopTrack = vi.fn();

beforeEach(() => {
	FakeRecorder.instances = [];
	stopTrack.mockClear();
	addAudioAsset.mockReset();
	vi.mocked(toast.error).mockClear();
	vi.stubGlobal("MediaRecorder", FakeRecorder);
	Object.defineProperty(navigator, "mediaDevices", {
		configurable: true,
		value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] })) },
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
});

function renderDialog(over: Partial<Parameters<typeof AddAudioLayerDialog>[0]> = {}) {
	const props = {
		open: true,
		maxDurationSec: 60,
		onClose: vi.fn(),
		onComplete: vi.fn(),
		onRecordingStart: vi.fn(),
		onRecordingStop: vi.fn(),
		...over,
	};
	const view = render(<AddAudioLayerDialog {...props} />);
	return { ...view, props };
}

describe("AddAudioLayerDialog", () => {
	it("tells the shell when a take starts, so it can capture the playhead", async () => {
		// The shell reads the playhead HERE, not when the take ends: recording
		// plays the video, so by the end the live playhead has advanced by the
		// take's own length. Every voiceover used to land that far to the right.
		const { props } = renderDialog();
		fireEvent.click(screen.getByText("audio.record"));
		await vi.waitFor(() => expect(props.onRecordingStart).toHaveBeenCalledTimes(1));
	});

	it("waits for preview playback before starting the recorder", async () => {
		let allowStart: (() => void) | undefined;
		const onRecordingStart = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					allowStart = resolve;
				}),
		);
		renderDialog({ onRecordingStart });

		fireEvent.click(screen.getByText("audio.record"));
		await vi.waitFor(() => expect(onRecordingStart).toHaveBeenCalledOnce());
		expect(FakeRecorder.instances[0].started).toBe(false);

		allowStart?.();
		await vi.waitFor(() => expect(FakeRecorder.instances[0].started).toBe(true));
	});

	it("releases the microphone and aborts when preview playback fails", async () => {
		const onRecordingStart = vi.fn().mockRejectedValue(new Error("playback failed"));
		const { props } = renderDialog({ onRecordingStart });

		fireEvent.click(screen.getByText("audio.record"));
		await vi.waitFor(() => expect(toast.error).toHaveBeenCalledWith("audio.recordingUnavailable"));

		expect(FakeRecorder.instances).toHaveLength(1);
		expect(FakeRecorder.instances[0].started).toBe(false);
		expect(stopTrack).toHaveBeenCalledOnce();
		expect(props.onRecordingStop).toHaveBeenCalledOnce();
	});

	it("does not cover the video it is recording against", () => {
		// It used to be a modal over a dimmed backdrop, which hid the one thing a
		// voiceover needs you to watch. It is a docked bar now: no backdrop, and
		// nothing claiming to be a modal dialog.
		const { container } = renderDialog();
		expect(container.querySelector('[aria-modal="true"]')).toBeNull();
		expect(container.querySelector('[class*="Backdrop"]')).toBeNull();
		expect(screen.getByText("audio.record")).toBeTruthy();
	});

	it("reports the end of a take, which is what un-mutes the timeline", async () => {
		// The shell silences the existing audio tracks between these two callbacks,
		// so a stop that never reported would leave the timeline mute for good.
		const { props } = renderDialog();
		fireEvent.click(screen.getByText("audio.record"));
		await vi.waitFor(() => expect(FakeRecorder.instances).toHaveLength(1));
		fireEvent.click(screen.getByText("audio.stop"));
		expect(props.onRecordingStop).toHaveBeenCalledTimes(1);
	});

	it("stops the recorder when the dialog is torn down mid-take", async () => {
		const { unmount, props } = renderDialog();
		fireEvent.click(screen.getByText("audio.record"));
		await vi.waitFor(() => expect(FakeRecorder.instances).toHaveLength(1));

		unmount();

		// Without this the take was never flushed, `onRecordingStop` never fired,
		// and the video element was left playing after the shell went away.
		expect(FakeRecorder.instances[0].stopped).toBe(true);
		expect(props.onRecordingStop).toHaveBeenCalled();
		// The microphone is released too.
		expect(stopTrack).toHaveBeenCalled();
	});

	it("does not import a take that was discarded by the teardown", async () => {
		const { unmount } = renderDialog();
		fireEvent.click(screen.getByText("audio.record"));
		await vi.waitFor(() => expect(FakeRecorder.instances).toHaveLength(1));
		unmount();
		expect(addAudioAsset).not.toHaveBeenCalled();
	});
});
