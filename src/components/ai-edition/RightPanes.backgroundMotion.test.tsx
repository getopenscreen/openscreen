// @vitest-environment jsdom
// The background animation control moves only what the compositor draws as a gradient. On any
// other wallpaper it is not shown at all, rather than holding a choice that changes nothing on
// screen, and the stored choice waits for the next gradient.

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { LOCALE_STORAGE_KEY } from "@/i18n/config";
import { createEmptyDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { VideoEffectsPane } from "./RightPanes";

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

const control = () => screen.getByRole("group", { name: "Animation" });
const choice = (name: string) => within(control()).getByRole("button", { name });

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
		expect(choice("Aurora")).toBeEnabled();
		expect(choice("None")).toHaveAttribute("aria-pressed", "true");

		fireEvent.click(choice("Aurora"));
		expect(useProjectStore.getState().document?.legacyEditor).toMatchObject({
			wallpaperMotion: "aurora",
		});
	});

	it("is not shown on an image, and keeps the stored choice for the next gradient", () => {
		renderWith({ wallpaper: "/wallpapers/wallpaper1.jpg", wallpaperMotion: "waves" });
		expect(screen.queryByRole("group", { name: "Animation" })).not.toBeInTheDocument();
		expect(useProjectStore.getState().document?.legacyEditor).toMatchObject({
			wallpaperMotion: "waves",
		});
	});
});
