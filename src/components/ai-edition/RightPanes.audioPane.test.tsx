// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { LOCALE_STORAGE_KEY } from "@/i18n/config";

const { setSettings } = vi.hoisted(() => ({ setSettings: vi.fn() }));

vi.mock("@/lib/ai-edition/store/useEditorSettings", () => ({
	useEditorSettings: () => ({
		settings: { audioGainDb: -6, recordingAudioMuted: true },
		set: setSettings,
		setLive: vi.fn(),
		commit: vi.fn(),
		hasDocument: true,
	}),
}));

import { AudioPane } from "./RightPanes";

beforeEach(() => {
	localStorage.clear();
	localStorage.setItem(LOCALE_STORAGE_KEY, "en");
	setSettings.mockClear();
});

afterEach(() => {
	cleanup();
	localStorage.clear();
});

describe("AudioPane reset button", () => {
	it("resets output gain and unmutes recording audio", () => {
		render(
			<I18nProvider>
				<AudioPane />
			</I18nProvider>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Reset audio" }));

		expect(setSettings).toHaveBeenCalledWith({ audioGainDb: 0, recordingAudioMuted: false });
	});
});
