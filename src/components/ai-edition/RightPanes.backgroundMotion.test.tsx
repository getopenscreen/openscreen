// @vitest-environment jsdom
// The background animation control moves only what the compositor draws as a gradient. On any
// other wallpaper it must be dead and say why, not hold a choice that changes nothing on screen.

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { LOCALE_STORAGE_KEY } from "@/i18n/config";
import { createEmptyDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { VideoEffectsPane } from "./RightPanes";

const REASON = /applies to gradient backgrounds only/i;

function renderWith(legacyEditor: Record<string, unknown>) {
	const base = createEmptyDocument({ projectId: "project_motion", title: "Motion" });
	useProjectStore.setState({
		projectId: base.project.id,
		document: { ...base, legacyEditor },
		revision: 1,
		status: "ready",
	});
	return render(
		<I18nProvider>
			<VideoEffectsPane />
		</I18nProvider>,
	);
}

const control = () => screen.getByRole("combobox", { name: "Animation" });

beforeEach(() => {
	localStorage.clear();
	localStorage.setItem(LOCALE_STORAGE_KEY, "en");
});

afterEach(() => {
	cleanup();
	localStorage.clear();
	useProjectStore.getState().clear();
});

describe("background animation control", () => {
	it("animates a gradient wallpaper", () => {
		renderWith({ wallpaper: "linear-gradient(135deg, #2b3a67, #b8577f)" });
		expect(control()).toBeEnabled();
		expect(control()).toHaveValue("none");
		expect(screen.queryByText(REASON)).not.toBeInTheDocument();

		fireEvent.change(control(), { target: { value: "aurora" } });
		expect(useProjectStore.getState().document?.legacyEditor).toMatchObject({
			wallpaperMotion: "aurora",
		});
	});

	it("is disabled with its reason on an image, and keeps the stored choice", () => {
		renderWith({ wallpaper: "/wallpapers/wallpaper1.jpg", wallpaperMotion: "waves" });
		expect(control()).toBeDisabled();
		expect(control()).toHaveValue("none");
		expect(screen.getByText(REASON)).toBeInTheDocument();
		expect(useProjectStore.getState().document?.legacyEditor).toMatchObject({
			wallpaperMotion: "waves",
		});
	});
});
