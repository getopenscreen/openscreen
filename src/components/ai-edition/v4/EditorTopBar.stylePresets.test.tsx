// @vitest-environment jsdom
// The editor top bar's Presets menu, driven through the real top bar and the real English
// catalog: the bridge, the settings hook, the platform and the toaster are the only fakes.

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { LOCALE_STORAGE_KEY } from "@/i18n/config";
import {
	DEFAULT_EDITOR_SETTINGS,
	type EditorSettingsSnapshot,
} from "@/lib/ai-edition/store/editorSettings";
import type { StylePreset } from "@/lib/ai-edition/stylePresets";
import {
	factoryStylePresetAppearance,
	stylePresetAppearanceFromSettings,
	stylePresetPatch,
} from "@/lib/ai-edition/stylePresetsEditor";
import { NativeBridgeRequestError } from "@/native/client";

type Fn = (...args: unknown[]) => unknown;

const state = vi.hoisted(() => ({
	platform: "darwin" as string,
	settings: null as EditorSettingsSnapshot | null,
	set: null as unknown as Mock<Fn>,
	presets: {
		list: null as unknown as Mock<Fn>,
		create: null as unknown as Mock<Fn>,
		rename: null as unknown as Mock<Fn>,
		update: null as unknown as Mock<Fn>,
		delete: null as unknown as Mock<Fn>,
		reveal: null as unknown as Mock<Fn>,
	},
	toastSuccess: null as unknown as Mock<Fn>,
}));

vi.mock("sonner", () => ({
	toast: {
		success: (...args: unknown[]) => state.toastSuccess(...args),
		error: vi.fn(),
	},
}));

vi.mock("@/utils/platformUtils", () => ({
	getPlatform: () => state.platform,
	isMac: () => state.platform === "darwin",
}));

vi.mock("@/lib/ai-edition/store/useEditorSettings", () => ({
	useEditorSettings: () => ({
		settings: state.settings,
		hasDocument: true,
		set: state.set,
		setLive: vi.fn(),
		commit: vi.fn(async () => undefined),
	}),
}));

vi.mock("@/native", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/native")>();
	return {
		...actual,
		isNativeCompositorActive: () => false,
		nativeBridgeClient: {
			...actual.nativeBridgeClient,
			presets: {
				list: (...args: unknown[]) => state.presets.list(...args),
				create: (...args: unknown[]) => state.presets.create(...args),
				rename: (...args: unknown[]) => state.presets.rename(...args),
				update: (...args: unknown[]) => state.presets.update(...args),
				delete: (...args: unknown[]) => state.presets.delete(...args),
				reveal: (...args: unknown[]) => state.presets.reveal(...args),
			},
		},
	};
});

import { EditorTopBar } from "./EditorTopBar";

const WARM: StylePreset = {
	id: "Warm",
	name: "Warm",
	updatedAt: "2026-09-01T10:00:00.000Z",
	appearance: { ...factoryStylePresetAppearance(), padding: 42, wallpaper: "#aa5500" },
};

const noop = () => {};

function renderPane() {
	localStorage.setItem(LOCALE_STORAGE_KEY, "en");
	return render(
		<I18nProvider>
			<EditorTopBar
				mode="edit"
				onModeChange={noop}
				projectTitle="Project"
				dirty={false}
				canExport={false}
				chatOpen={false}
				actions={{
					openProject: noop,
					newProject: noop,
					save: noop,
					export: noop,
					openSettings: noop,
					renameProject: noop,
					toggleChat: noop,
					openProviderSettings: noop,
					showAbout: noop,
					checkForUpdates: noop,
				}}
			/>
		</I18nProvider>,
	);
}

async function openMenu() {
	fireEvent.click(screen.getByRole("button", { name: "Presets" }));
	const menu = await screen.findByRole("menu", { name: "Style presets" });
	await waitFor(() => expect(menu).toHaveAttribute("aria-busy", "false"));
	return menu;
}

function openRowActions(name: string) {
	fireEvent.click(screen.getByRole("button", { name: `More actions for ${name}` }));
}

beforeEach(() => {
	localStorage.clear();
	state.platform = "darwin";
	state.settings = DEFAULT_EDITOR_SETTINGS;
	state.set = vi.fn<Fn>(async () => true);
	state.toastSuccess = vi.fn<Fn>();
	state.presets.list = vi.fn<Fn>(async () => [WARM]);
	state.presets.create = vi.fn<Fn>(async (name) => ({ ...WARM, id: name, name }));
	state.presets.rename = vi.fn<Fn>(async (id, name) => ({ ...WARM, id, name }));
	state.presets.update = vi.fn<Fn>(async () => WARM);
	state.presets.delete = vi.fn<Fn>(async () => ({ success: true }));
	state.presets.reveal = vi.fn<Fn>(async () => ({ success: true }));
});

afterEach(() => {
	cleanup();
	localStorage.clear();
});

describe("Presets menu in the editor top bar", () => {
	it("lists the built-in preset first, then the saved ones", async () => {
		renderPane();
		const menu = await openMenu();
		const rows = within(menu).getAllByRole("menuitemradio");
		expect(rows.map((row) => row.textContent)).toEqual(["OpenScreenBuilt-in", "Warm"]);
		expect(state.presets.list).toHaveBeenCalledTimes(1);
		// The built-in row manages nothing: only the saved one has a "⋯".
		expect(screen.getAllByRole("button", { name: /^More actions for/ })).toHaveLength(1);
	});

	it("says so when nothing is saved yet", async () => {
		state.presets.list = vi.fn<Fn>(async () => []);
		renderPane();
		const menu = await openMenu();
		expect(within(menu).getByText("No saved presets yet")).toBeInTheDocument();
	});

	it("stays usable for the built-in preset and create when the list fails", async () => {
		state.presets.list = vi.fn<Fn>(async () => {
			throw new Error("EACCES");
		});
		renderPane();
		const menu = await openMenu();
		expect(within(menu).getByRole("alert")).toHaveTextContent("Could not load presets");
		expect(within(menu).getByRole("menuitemradio", { name: /OpenScreen/ })).toBeInTheDocument();
		expect(within(menu).getByRole("menuitem", { name: "Create new preset…" })).toBeInTheDocument();
	});

	it("applies a saved preset as one settings write and closes the menu", async () => {
		renderPane();
		await openMenu();
		fireEvent.click(screen.getByRole("menuitemradio", { name: "Warm" }));
		expect(state.set).toHaveBeenCalledTimes(1);
		expect(state.set).toHaveBeenCalledWith(stylePresetPatch(WARM.appearance));
		expect(screen.queryByRole("menu")).not.toBeInTheDocument();
		await waitFor(() => expect(state.toastSuccess).toHaveBeenCalledWith("Applied “Warm”"));
	});

	it("does not report an applied preset when the project save fails", async () => {
		state.set = vi.fn<Fn>(async () => false);
		renderPane();
		await openMenu();
		fireEvent.click(screen.getByRole("menuitemradio", { name: "Warm" }));
		await waitFor(() => expect(state.set).toHaveBeenCalledTimes(1));
		expect(state.toastSuccess).not.toHaveBeenCalled();
	});

	it("applies the built-in preset from its row", async () => {
		state.settings = { ...DEFAULT_EDITOR_SETTINGS, padding: 7 };
		renderPane();
		await openMenu();
		fireEvent.click(screen.getByRole("menuitemradio", { name: /OpenScreen/ }));
		expect(state.set).toHaveBeenCalledTimes(1);
		expect(state.set).toHaveBeenCalledWith(stylePresetPatch(factoryStylePresetAppearance()));
	});

	it("marks the row matching the current look", async () => {
		renderPane();
		await openMenu();
		expect(screen.getByRole("menuitemradio", { name: /OpenScreen/ })).toHaveAttribute(
			"aria-checked",
			"true",
		);
		expect(screen.getByRole("menuitemradio", { name: "Warm" })).toHaveAttribute(
			"aria-checked",
			"false",
		);
		cleanup();

		state.settings = { ...DEFAULT_EDITOR_SETTINGS, padding: 42, wallpaper: "#aa5500" };
		renderPane();
		await openMenu();
		expect(screen.getByRole("menuitemradio", { name: "Warm" })).toHaveAttribute(
			"aria-checked",
			"true",
		);
		expect(screen.getByRole("menuitemradio", { name: /OpenScreen/ })).toHaveAttribute(
			"aria-checked",
			"false",
		);
	});

	it("opens a row's actions from “⋯” without applying the preset", async () => {
		renderPane();
		await openMenu();
		openRowActions("Warm");
		expect(state.set).not.toHaveBeenCalled();
		expect(screen.getByRole("menu")).toBeInTheDocument();
		expect(screen.getByRole("menuitem", { name: "Rename" })).toBeInTheDocument();
	});

	it("creates a preset from the current look", async () => {
		state.presets.list = vi
			.fn()
			.mockResolvedValueOnce([WARM])
			.mockResolvedValueOnce([{ ...WARM, id: "My look", name: "My look" }, WARM]);
		renderPane();
		await openMenu();
		fireEvent.click(screen.getByRole("menuitem", { name: "Create new preset…" }));
		const input = screen.getByRole("textbox", { name: "Preset name" });
		expect(input).toHaveFocus();
		fireEvent.change(input, { target: { value: "  My   look " } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() =>
			expect(state.presets.create).toHaveBeenCalledWith(
				"My look",
				stylePresetAppearanceFromSettings(DEFAULT_EDITOR_SETTINGS),
			),
		);
		expect(await screen.findByRole("menuitemradio", { name: "My look" })).toBeInTheDocument();
		expect(state.presets.list).toHaveBeenCalledTimes(2);
		expect(state.toastSuccess).toHaveBeenCalledWith("Preset saved");
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
	});

	it("blocks repeated Enter submissions while create is busy", async () => {
		let finishCreate: (() => void) | undefined;
		state.presets.create = vi.fn<Fn>(
			() => new Promise<void>((resolve) => (finishCreate = resolve)),
		);
		renderPane();
		await openMenu();
		fireEvent.click(screen.getByRole("menuitem", { name: "Create new preset…" }));
		const input = screen.getByRole("textbox", { name: "Preset name" });
		fireEvent.change(input, { target: { value: "Mine" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(input).toBeDisabled());
		fireEvent.keyDown(input, { key: "Enter" });
		expect(state.presets.create).toHaveBeenCalledTimes(1);
		finishCreate?.();
	});

	it("asks for a name instead of saving a blank one", async () => {
		renderPane();
		await openMenu();
		fireEvent.click(screen.getByRole("menuitem", { name: "Create new preset…" }));
		const input = screen.getByRole("textbox", { name: "Preset name" });
		fireEvent.change(input, { target: { value: "   " } });
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("Enter a name");
		expect(state.presets.create).not.toHaveBeenCalled();
	});

	it("reports a taken name", async () => {
		state.presets.create = vi.fn<Fn>(async () => {
			throw new NativeBridgeRequestError({
				code: "NAME_TAKEN",
				message: "taken",
				retryable: false,
			});
		});
		renderPane();
		await openMenu();
		fireEvent.click(screen.getByRole("menuitem", { name: "Create new preset…" }));
		fireEvent.change(screen.getByRole("textbox", { name: "Preset name" }), {
			target: { value: "Warm" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"A preset with this name already exists",
		);
		expect(screen.getByRole("textbox", { name: "Preset name" })).toBeInTheDocument();
	});

	it("surfaces any other save failure with its message", async () => {
		state.presets.create = vi.fn<Fn>(async () => {
			throw new NativeBridgeRequestError({
				code: "INVALID_REQUEST",
				message: "Unsupported wallpaper",
				retryable: false,
			});
		});
		renderPane();
		await openMenu();
		fireEvent.click(screen.getByRole("menuitem", { name: "Create new preset…" }));
		fireEvent.change(screen.getByRole("textbox", { name: "Preset name" }), {
			target: { value: "Mine" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Could not save the preset: Unsupported wallpaper",
		);
	});

	it("backs out of the name field on Escape without closing the menu", async () => {
		renderPane();
		await openMenu();
		fireEvent.click(screen.getByRole("menuitem", { name: "Create new preset…" }));
		fireEvent.keyDown(screen.getByRole("textbox", { name: "Preset name" }), { key: "Escape" });
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
		expect(screen.getByRole("menu")).toBeInTheDocument();
		expect(screen.getByRole("menuitem", { name: "Create new preset…" })).toBeInTheDocument();
	});

	it("renames a preset inline", async () => {
		renderPane();
		await openMenu();
		openRowActions("Warm");
		fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
		const input = screen.getByRole("textbox", { name: "Preset name" });
		expect(input).toHaveValue("Warm");
		fireEvent.change(input, { target: { value: "Cosy" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(state.presets.rename).toHaveBeenCalledWith("Warm", "Cosy"));
		await waitFor(() => expect(state.presets.list).toHaveBeenCalledTimes(2));
		expect(state.set).not.toHaveBeenCalled();
	});

	it("reports a taken name on rename", async () => {
		state.presets.rename = vi.fn<Fn>(async () => {
			throw new NativeBridgeRequestError({ code: "NAME_TAKEN", message: "x", retryable: false });
		});
		renderPane();
		await openMenu();
		openRowActions("Warm");
		fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
		fireEvent.change(screen.getByRole("textbox", { name: "Preset name" }), {
			target: { value: "Other" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"A preset with this name already exists",
		);
	});

	it("updates a preset from the current look", async () => {
		state.settings = { ...DEFAULT_EDITOR_SETTINGS, borderRadius: 18 };
		renderPane();
		await openMenu();
		openRowActions("Warm");
		fireEvent.click(screen.getByRole("menuitem", { name: "Update from current project" }));
		await waitFor(() =>
			expect(state.presets.update).toHaveBeenCalledWith(
				"Warm",
				stylePresetAppearanceFromSettings(state.settings as EditorSettingsSnapshot),
			),
		);
		await waitFor(() => expect(state.toastSuccess).toHaveBeenCalledWith("Preset updated"));
		expect(state.presets.list).toHaveBeenCalledTimes(2);
	});

	it("shows why an update was refused", async () => {
		state.presets.update = vi.fn<Fn>(async () => {
			throw new Error("Unsupported wallpaper");
		});
		renderPane();
		await openMenu();
		openRowActions("Warm");
		fireEvent.click(screen.getByRole("menuitem", { name: "Update from current project" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Could not save the preset: Unsupported wallpaper",
		);
	});

	it("deletes only after confirmation", async () => {
		state.presets.list = vi.fn<Fn>().mockResolvedValueOnce([WARM]).mockResolvedValueOnce([]);
		renderPane();
		await openMenu();
		openRowActions("Warm");
		fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
		expect(state.presets.delete).not.toHaveBeenCalled();
		expect(screen.getByText("Delete “Warm”?")).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(screen.queryByText("Delete “Warm”?")).not.toBeInTheDocument();
		expect(state.presets.delete).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
		fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		await waitFor(() => expect(state.presets.delete).toHaveBeenCalledWith("Warm"));
		expect(await screen.findByText("No saved presets yet")).toBeInTheDocument();
	});

	it.each([
		["darwin", "Show in Finder"],
		["win32", "Show in Explorer"],
		["linux", "Show in folder"],
	])("names the reveal action for %s and reveals the file", async (platform, label) => {
		state.platform = platform;
		renderPane();
		await openMenu();
		openRowActions("Warm");
		fireEvent.click(screen.getByRole("menuitem", { name: label }));
		await waitFor(() => expect(state.presets.reveal).toHaveBeenCalledWith("Warm"));
		expect(state.set).not.toHaveBeenCalled();
	});
});
