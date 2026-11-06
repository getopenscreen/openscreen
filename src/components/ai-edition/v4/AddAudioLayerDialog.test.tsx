// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { Blob as NodeBlob } from "node:buffer";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
	state: "inactive" | "recording" | "paused" = "inactive";
	pauseCount = 0;
	resumeCount = 0;
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
	pause() {
		this.state = "paused";
		this.pauseCount++;
	}
	resume() {
		this.state = "recording";
		this.resumeCount++;
	}
	stop() {
		this.stopped = true;
		this.state = "inactive";
		this.ondataavailable?.({ data: new Blob(["audio"]) });
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
	vi.stubGlobal("Blob", NodeBlob);
	Object.defineProperty(window, "electronAPI", {
		configurable: true,
		value: { saveRecordedVoiceover: vi.fn(async () => ({ success: true, path: "/voice.webm" })) },
	});
	addAudioAsset.mockResolvedValue({ id: "voice" });
	Object.defineProperty(navigator, "mediaDevices", {
		configurable: true,
		value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] })) },
	});
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.restoreAllMocks();
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
		onRecordingPause: vi.fn(),
		onRecordingResume: vi.fn(async () => undefined),
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

describe("voiceover pause and resume", () => {
	let now = 0;
	beforeEach(() => {
		now = 0;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
	});
	async function start(over: Partial<Parameters<typeof AddAudioLayerDialog>[0]> = {}) {
		const result = renderDialog(over);
		await act(async () => {
			fireEvent.click(screen.getByText("audio.record"));
		});
		return result;
	}
	function tick(at: number) {
		now = at;
		act(() => {
			vi.advanceTimersByTime(200);
		});
	}

	it("freezes its clock across repeated pauses and saves one take with only active time", async () => {
		const { props } = await start({ maxDurationSec: 6 });
		tick(3000);
		fireEvent.click(screen.getByRole("button", { name: "audio.pause" }));
		expect(FakeRecorder.instances[0].state).toBe("paused");
		expect(props.onRecordingPause).toHaveBeenCalledOnce();
		tick(13000);
		expect(screen.getByText("audio.paused 3.0s")).toBeInTheDocument();
		expect(FakeRecorder.instances[0].stopped).toBe(false);
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "audio.resume" }));
		});
		tick(14000);
		fireEvent.click(screen.getByRole("button", { name: "audio.pause" }));
		tick(24000);
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "audio.resume" }));
		});
		tick(25000);
		await act(async () => {
			fireEvent.click(screen.getByText("audio.stop"));
		});
		expect(props.onComplete).toHaveBeenCalledWith("voice", 5);
		expect(addAudioAsset).toHaveBeenCalledOnce();
		expect(FakeRecorder.instances).toHaveLength(1);
		expect(props.onRecordingStart).toHaveBeenCalledOnce();
		expect(props.onRecordingResume).toHaveBeenCalledTimes(2);
	});

	it("stops and saves a paused take without including the wait", async () => {
		const { props } = await start();
		tick(2000);
		fireEvent.click(screen.getByRole("button", { name: "audio.pause" }));
		tick(22000);
		await act(async () => {
			fireEvent.click(screen.getByText("audio.stop"));
		});
		expect(props.onComplete).toHaveBeenCalledWith("voice", 2);
		expect(stopTrack).toHaveBeenCalledOnce();
	});

	it.each([
		"cancel",
		"escape",
		"unmount",
	])("discards and releases a paused take on %s", async (how) => {
		const { unmount, props } = await start();
		fireEvent.click(screen.getByRole("button", { name: "audio.pause" }));
		if (how === "unmount") unmount();
		else if (how === "escape") fireEvent.keyDown(window, { key: "Escape" });
		else fireEvent.click(screen.getByText("actions.cancel"));
		expect(FakeRecorder.instances[0].stopped).toBe(true);
		expect(stopTrack).toHaveBeenCalled();
		expect(props.onRecordingStop).toHaveBeenCalled();
		expect(addAudioAsset).not.toHaveBeenCalled();
	});

	it("leaves the recorder paused on preview resume failure, and permits retry", async () => {
		const onRecordingResume = vi
			.fn()
			.mockRejectedValueOnce(new Error("play blocked"))
			.mockResolvedValue(undefined);
		const { props } = await start({ onRecordingResume });
		tick(1000);
		fireEvent.click(screen.getByRole("button", { name: "audio.pause" }));
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "audio.resume" }));
		});
		expect(FakeRecorder.instances[0].state).toBe("paused");
		expect(toast.error).toHaveBeenCalledWith("audio.recordingUnavailable");
		tick(11000);
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "audio.resume" }));
		});
		tick(12000);
		await act(async () => {
			fireEvent.click(screen.getByText("audio.stop"));
		});
		expect(props.onComplete).toHaveBeenCalledWith("voice", 2);
	});

	it("does not revive a take stopped while preview resume is pending", async () => {
		let finishResume!: () => void;
		const onRecordingResume = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finishResume = resolve;
				}),
		);
		const { props } = await start({ onRecordingResume });
		tick(1000);
		fireEvent.click(screen.getByRole("button", { name: "audio.pause" }));
		fireEvent.click(screen.getByRole("button", { name: "audio.resume" }));
		expect(screen.getByRole("button", { name: "audio.resume" })).toBeDisabled();
		await act(async () => {
			fireEvent.click(screen.getByText("audio.stop"));
		});
		await act(async () => {
			finishResume();
		});
		expect(FakeRecorder.instances[0].resumeCount).toBe(0);
		expect(props.onComplete).toHaveBeenCalledOnce();
	});
});
