// @vitest-environment jsdom
// The transcript pane's empty state is what a user meets before any transcript
// exists — and, since transcription now runs by itself in the background, it is
// also where they wait for one. These assertions pin the three answers it has
// to give: "it's coming", "here's the button", and "this media has no audio, so
// there is nothing to press".

import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { LOCALE_STORAGE_KEY } from "@/i18n/config";
import type { AxcutAsset, AxcutClip } from "@/lib/ai-edition/schema";
import type {
	AssetTranscriptionView,
	TranscriptGateReason,
} from "@/lib/ai-edition/transcription/status";
import { TranscriptPane } from "./RightPanes";
import { TranscriptionSettings } from "./TranscriptionSettings";

vi.mock("@/native/client", () => ({ nativeBridgeClient: { aiEdition: {} } }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const getSettings = vi.fn();
const updateSettings = vi.fn();
beforeEach(() => {
	getSettings.mockResolvedValue({ provider: "whisper", cloudConsent: false, hasApiKey: true });
	updateSettings.mockImplementation(async () => {
		const next = { provider: "gmi", cloudConsent: true, hasApiKey: true };
		getSettings.mockResolvedValue(next);
		return next;
	});
	Object.defineProperty(window, "electronAPI", {
		configurable: true,
		value: { stt: { getSettings, updateSettings } },
	});
});

const ASSET: AxcutAsset = {
	id: "asset_1",
	kind: "video",
	label: "recording.mp4",
	originalPath: "/rec.mp4",
	durationSec: 12,
	cameraTrack: null,
};

const CLIPS: AxcutClip[] = [
	{
		id: "clip_1",
		assetId: "asset_1",
		sourceStartSec: 0,
		sourceEndSec: 12,
		timelineStartSec: 0,
		timelineEndSec: 12,
		wordRefs: [],
		origin: "user",
		reason: "",
	},
];

function renderPane(
	overrides: {
		isTranscribing?: boolean;
		busyView?: AssetTranscriptionView;
		blocked?: { reason: TranscriptGateReason; message?: string };
	} = {},
) {
	return render(
		<I18nProvider>
			<TranscriptPane
				clips={CLIPS}
				audioTracks={[]}
				transcripts={[]}
				assets={[ASSET]}
				trimRanges={[]}
				busyAssetIds={[]}
				onSeek={vi.fn()}
				onTrimTimelineSpan={vi.fn()}
				onRemoveTrimRanges={vi.fn()}
				onSetWordText={vi.fn()}
				onInsertWord={vi.fn()}
				onRemoveWords={vi.fn()}
				onTranscribe={vi.fn()}
				canTranscribe
				isTranscribing={overrides.isTranscribing ?? false}
				busyView={overrides.busyView}
				blocked={overrides.blocked}
			/>
		</I18nProvider>,
	);
}

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	localStorage.clear();
});

describe("transcript pane gating", () => {
	it("describes GMI cloud upload during transcription without promising local-only privacy", async () => {
		localStorage.setItem(LOCALE_STORAGE_KEY, "zh-TW");
		getSettings.mockResolvedValue({ provider: "gmi", cloudConsent: true, hasApiKey: true });
		renderPane({
			isTranscribing: true,
			busyView: { assetId: ASSET.id, status: "running", backend: "gmi-gemini" },
		});
		expect(
			await screen.findByText("允許將錄影音訊傳送至 GMI Cloud 進行轉錄，可能產生 API 費用。"),
		).toBeInTheDocument();
		expect(screen.queryByText(/資料不會離開本裝置/)).toBeNull();
	});

	it("uses the running GMI backend even when the next saved provider is Whisper", async () => {
		localStorage.setItem(LOCALE_STORAGE_KEY, "zh-TW");
		await act(async () => {
			renderPane({
				isTranscribing: true,
				busyView: { assetId: ASSET.id, status: "running", backend: "gmi-gemini" },
			});
		});
		expect(getSettings).toHaveBeenCalled();
		expect(
			screen.getByText("允許將錄影音訊傳送至 GMI Cloud 進行轉錄，可能產生 API 費用。"),
		).toBeInTheDocument();
		expect(screen.queryByText(/資料不會離開本裝置/)).toBeNull();
	});

	it("does not infer a running backend from the next saved Whisper provider", async () => {
		localStorage.setItem(LOCALE_STORAGE_KEY, "zh-TW");
		await act(async () => {
			renderPane({
				isTranscribing: true,
				busyView: { assetId: ASSET.id, status: "running", phase: "extracting-audio" },
			});
		});
		expect(getSettings).toHaveBeenCalled();
		expect(screen.getByText("選擇產生逐字稿與字幕的轉錄引擎。")).toBeInTheDocument();
		expect(screen.queryByText(/資料不會離開本裝置/)).toBeNull();
	});

	it("states local-only privacy only after Whisper is confirmed by the provider settings", async () => {
		localStorage.setItem(LOCALE_STORAGE_KEY, "zh-TW");
		renderPane();
		expect(await screen.findByText(/逐字稿使用本機 Whisper/)).toBeInTheDocument();
		expect(screen.queryByText(/音訊傳送至 GMI Cloud/)).toBeNull();
	});

	it("refreshes the privacy statement when the user saves a different transcription provider", async () => {
		localStorage.setItem(LOCALE_STORAGE_KEY, "zh-TW");
		renderPane();
		await screen.findByText(/逐字稿使用本機 Whisper/);
		render(
			<I18nProvider>
				<TranscriptionSettings open />
			</I18nProvider>,
		);
		await screen.findByRole("combobox", { name: "轉錄引擎" });
		fireEvent.change(screen.getByRole("combobox"), { target: { value: "gmi" } });
		fireEvent.click(
			screen.getByRole("checkbox", {
				name: "允許將錄影音訊傳送至 GMI Cloud 進行轉錄，可能產生 API 費用。",
			}),
		);
		fireEvent.click(screen.getByRole("button", { name: "儲存轉錄設定" }));
		await waitFor(() =>
			expect(
				screen.getAllByText("允許將錄影音訊傳送至 GMI Cloud 進行轉錄，可能產生 API 費用。"),
			).toHaveLength(2),
		);
		expect(screen.queryByText(/資料不會離開本裝置/)).toBeNull();
	});

	it("does not claim local-only privacy when the provider settings cannot be read", async () => {
		localStorage.setItem(LOCALE_STORAGE_KEY, "zh-TW");
		getSettings.mockRejectedValue(new Error("settings unavailable"));
		renderPane();
		expect(await screen.findByText("選擇產生逐字稿與字幕的轉錄引擎。")).toBeInTheDocument();
		expect(screen.queryByText(/資料不會離開本裝置/)).toBeNull();
	});

	it("offers the button while nothing has been attempted", () => {
		renderPane();
		expect(screen.getByRole("button", { name: "Transcribe now" })).toBeEnabled();
	});

	it("shows the background run in progress instead of an idle button", () => {
		renderPane({ isTranscribing: true });
		const button = screen.getByRole("button", { name: "Starting speech model" });
		expect(button).toBeDisabled();
		expect(screen.queryByRole("button", { name: "Transcribing…" })).toBeNull();
	});

	it("disables the button when the timeline's media have no audio track, and says why", () => {
		renderPane({ blocked: { reason: "no-audio" } });
		expect(screen.getByRole("button", { name: "Transcribe now" })).toBeDisabled();
		expect(screen.getByText("This media has no audio track")).toBeInTheDocument();
	});

	it("keeps the retry available after a transient failure, and surfaces the engine message", () => {
		renderPane({ blocked: { reason: "failed", message: "whisper-server exited" } });
		expect(screen.getByRole("button", { name: "Transcribe now" })).toBeEnabled();
		expect(screen.getByText("whisper-server exited")).toBeInTheDocument();
	});
});
