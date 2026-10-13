// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { TRANSCRIPTION_SETTINGS_CHANGED_EVENT } from "@/hooks/useTranscriptionProvider";
import { LOCALE_STORAGE_KEY } from "@/i18n/config";
import { TranscriptionSettings } from "./TranscriptionSettings";

const getSettings = vi.fn();
const updateSettings = vi.fn();
beforeEach(() => {
	localStorage.setItem(LOCALE_STORAGE_KEY, "zh-TW");
	getSettings.mockResolvedValue({ provider: "whisper", cloudConsent: false, hasApiKey: false });
	updateSettings.mockResolvedValue({ provider: "gmi", cloudConsent: true, hasApiKey: true });
	Object.defineProperty(window, "electronAPI", {
		configurable: true,
		value: { stt: { getSettings, updateSettings } },
	});
});
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	localStorage.clear();
});
describe("TranscriptionSettings", () => {
	it("offers Traditional Chinese as an explicit saved preference", async () => {
		render(
			<I18nProvider>
				<TranscriptionSettings open />
			</I18nProvider>,
		);
		await screen.findByRole("combobox", { name: "轉錄引擎" });
		const checkbox = screen.getByRole("checkbox", { name: "中文輸出繁體（臺灣）" });
		expect(checkbox).not.toBeChecked();
		fireEvent.click(checkbox);
		fireEvent.click(screen.getByRole("button", { name: "儲存轉錄設定" }));
		await waitFor(() =>
			expect(updateSettings).toHaveBeenCalledWith({
				provider: "whisper",
				cloudConsent: false,
				autoTranscribe: true,
				traditionalChinese: true,
			}),
		);
	});

	it("disables AGY until a local CLI is found", async () => {
		render(
			<I18nProvider>
				<TranscriptionSettings open />
			</I18nProvider>,
		);
		await screen.findByRole("combobox", { name: "轉錄引擎" });
		expect(screen.getByRole("option", { name: "AGY Gemini（雲端）" })).toBeDisabled();
	});
	it("keeps AGY upload consent separate from an existing GMI approval", async () => {
		getSettings.mockResolvedValue({
			provider: "gmi",
			cloudConsent: true,
			hasApiKey: true,
			agyAvailable: true,
			autoTranscribe: true,
		});
		updateSettings.mockResolvedValue({
			provider: "agy",
			cloudConsent: false,
			agyCloudConsent: true,
			hasApiKey: true,
			agyAvailable: true,
			autoTranscribe: true,
		});
		render(
			<I18nProvider>
				<TranscriptionSettings open />
			</I18nProvider>,
		);
		await screen.findByText("金鑰已設定");
		fireEvent.change(screen.getByRole("combobox"), { target: { value: "agy" } });
		const consent = screen.getByRole("checkbox", { name: /^允許將音訊透過 AGY/ });
		expect(consent).not.toBeChecked();
		expect(screen.getByRole("button", { name: "儲存轉錄設定" })).toBeDisabled();
		fireEvent.click(consent);
		fireEvent.click(screen.getByRole("button", { name: "儲存轉錄設定" }));
		await waitFor(() =>
			expect(updateSettings).toHaveBeenCalledWith({
				provider: "agy",
				cloudConsent: false,
				agyCloudConsent: true,
				autoTranscribe: true,
			}),
		);
	});

	it("requires a credential and explicit audio upload consent before saving GMI", async () => {
		render(
			<I18nProvider>
				<TranscriptionSettings open />
			</I18nProvider>,
		);
		await screen.findByRole("combobox", { name: "轉錄引擎" });
		fireEvent.change(screen.getByRole("combobox"), { target: { value: "gmi" } });
		const save = screen.getByRole("button", { name: "儲存轉錄設定" });
		expect(save).toBeDisabled();
		fireEvent.change(screen.getByLabelText("GMI API 金鑰"), { target: { value: "private-token" } });
		expect(save).toBeDisabled();
		fireEvent.click(screen.getByRole("checkbox", { name: /^允許將錄影音訊/ }));
		fireEvent.click(save);
		await waitFor(() =>
			expect(updateSettings).toHaveBeenCalledWith({
				provider: "gmi",
				cloudConsent: true,
				autoTranscribe: true,
				apiKey: "private-token",
			}),
		);
		await waitFor(() => expect(screen.getByLabelText("GMI API 金鑰")).toHaveValue(""));
	});
	it("never requires the stored key to be returned to the renderer", async () => {
		getSettings.mockResolvedValue({ provider: "gmi", cloudConsent: true, hasApiKey: true });
		render(
			<I18nProvider>
				<TranscriptionSettings open />
			</I18nProvider>,
		);
		await screen.findByText("金鑰已設定");
		expect(screen.getByLabelText("GMI API 金鑰")).toHaveAttribute("type", "password");
		fireEvent.click(screen.getByRole("button", { name: "儲存轉錄設定" }));
		await waitFor(() =>
			expect(updateSettings).toHaveBeenCalledWith({
				provider: "gmi",
				cloudConsent: true,
				autoTranscribe: true,
			}),
		);
	});
	it("disconnects GMI and revokes automatic upload consent together", async () => {
		getSettings.mockResolvedValue({ provider: "gmi", cloudConsent: true, hasApiKey: true });
		render(
			<I18nProvider>
				<TranscriptionSettings open />
			</I18nProvider>,
		);
		await screen.findByRole("button", { name: "移除 GMI 金鑰" });
		fireEvent.click(screen.getByRole("button", { name: "移除 GMI 金鑰" }));
		await waitFor(() =>
			expect(updateSettings).toHaveBeenCalledWith({
				provider: "whisper",
				cloudConsent: false,
				apiKey: "",
			}),
		);
	});
	it("loads disabled automatic transcription and saves it without replacing the stored key", async () => {
		getSettings.mockResolvedValue({
			provider: "gmi",
			cloudConsent: true,
			hasApiKey: true,
			autoTranscribe: false,
		});
		updateSettings.mockResolvedValue({
			provider: "gmi",
			cloudConsent: true,
			hasApiKey: true,
			autoTranscribe: false,
		});
		render(
			<I18nProvider>
				<TranscriptionSettings open />
			</I18nProvider>,
		);
		await screen.findByText("金鑰已設定");
		expect(screen.getByRole("checkbox", { name: "自動轉錄新影片" })).not.toBeChecked();
		expect(screen.getByText("關閉後可自行處理音訊，再匯入 SRT 字幕。")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "儲存轉錄設定" }));
		await waitFor(() =>
			expect(updateSettings).toHaveBeenCalledWith({
				provider: "gmi",
				cloudConsent: true,
				autoTranscribe: false,
			}),
		);
		expect(updateSettings.mock.calls[0][0]).not.toHaveProperty("apiKey");
	});

	it("can disable automatic transcription and broadcasts only a refresh event", async () => {
		getSettings.mockResolvedValue({ provider: "gmi", cloudConsent: true, hasApiKey: true });
		updateSettings.mockResolvedValue({
			provider: "gmi",
			cloudConsent: true,
			hasApiKey: true,
			autoTranscribe: false,
		});
		const refreshed = vi.fn();
		window.addEventListener(TRANSCRIPTION_SETTINGS_CHANGED_EVENT, refreshed);
		try {
			render(
				<I18nProvider>
					<TranscriptionSettings open />
				</I18nProvider>,
			);
			await screen.findByText("金鑰已設定");
			const automatic = screen.getByRole("checkbox", { name: "自動轉錄新影片" });
			expect(automatic).toBeChecked();
			fireEvent.click(automatic);
			fireEvent.click(screen.getByRole("button", { name: "儲存轉錄設定" }));
			await waitFor(() => expect(refreshed).toHaveBeenCalledTimes(1));
			expect(updateSettings).toHaveBeenCalledWith({
				provider: "gmi",
				cloudConsent: true,
				autoTranscribe: false,
			});
			expect(refreshed.mock.calls[0][0]).not.toHaveProperty("detail");
			expect(automatic).not.toBeChecked();
		} finally {
			window.removeEventListener(TRANSCRIPTION_SETTINGS_CHANGED_EVENT, refreshed);
		}
	});

	it("does not require an active GMI credential to turn automatic transcription off", async () => {
		getSettings.mockResolvedValue({ provider: "gmi", cloudConsent: false, hasApiKey: false });
		render(
			<I18nProvider>
				<TranscriptionSettings open />
			</I18nProvider>,
		);
		const automatic = await screen.findByRole("checkbox", { name: "自動轉錄新影片" });
		await waitFor(() => expect(automatic).toBeEnabled());
		fireEvent.click(automatic);
		const save = screen.getByRole("button", { name: "儲存轉錄設定" });
		expect(save).toBeEnabled();
		fireEvent.click(save);
		await waitFor(() =>
			expect(updateSettings).toHaveBeenCalledWith({
				provider: "gmi",
				cloudConsent: false,
				autoTranscribe: false,
			}),
		);
	});
});
