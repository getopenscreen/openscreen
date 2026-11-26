// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { useTranscriptionStore } from "@/lib/ai-edition/store/transcriptionStore";
import { loadUserPreferences, saveUserPreferences } from "@/lib/userPreferences";
import { TranscriptionSettings } from "./TranscriptionSettings";

function renderSection() {
	return render(
		<I18nProvider>
			<TranscriptionSettings />
		</I18nProvider>,
	);
}

describe("TranscriptionSettings", () => {
	afterEach(() => {
		cleanup();
		useTranscriptionStore.setState({ autoTranscribe: true });
		localStorage.clear();
	});

	it("shows automatic transcription on by default, and says what it downloads", () => {
		renderSection();
		expect(screen.getByTestId("auto-transcribe-toggle")).toHaveAttribute("aria-pressed", "true");
		expect(screen.getByText(/huggingface\.co/)).toBeInTheDocument();
	});

	it("reflects the store's value", () => {
		useTranscriptionStore.setState({ autoTranscribe: false });
		renderSection();
		expect(screen.getByTestId("auto-transcribe-toggle")).toHaveAttribute("aria-pressed", "false");
	});

	it("turns it off and saves the choice", () => {
		renderSection();
		fireEvent.click(screen.getByTestId("auto-transcribe-toggle"));
		expect(screen.getByTestId("auto-transcribe-toggle")).toHaveAttribute("aria-pressed", "false");
		expect(useTranscriptionStore.getState().autoTranscribe).toBe(false);
		expect(loadUserPreferences().autoTranscribe).toBe(false);
	});

	it("turns it back on and saves the choice", () => {
		// Saved as off too, so the check below cannot pass on the default alone.
		saveUserPreferences({ autoTranscribe: false });
		useTranscriptionStore.setState({ autoTranscribe: false });
		renderSection();
		fireEvent.click(screen.getByTestId("auto-transcribe-toggle"));
		expect(screen.getByTestId("auto-transcribe-toggle")).toHaveAttribute("aria-pressed", "true");
		expect(useTranscriptionStore.getState().autoTranscribe).toBe(true);
		expect(loadUserPreferences().autoTranscribe).toBe(true);
	});
});
