// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { LOCALE_STORAGE_KEY } from "@/i18n/config";
import { createEmptyDocument } from "@/lib/ai-edition/schema";
import { getEditorSettings } from "@/lib/ai-edition/store/editorSettings";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { CURSOR_THEMES, DEFAULT_CURSOR_SPRITES } from "@/lib/cursor/cursorThemes";
import { nativeBridgeClient } from "@/native";
import { CursorPane } from "./RightPanes";

function stubStorage() {
	const store = new Map<string, string>();
	const localStorage = {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => {
			store.set(key, value);
		},
		removeItem: (key: string) => {
			store.delete(key);
		},
		clear: () => {
			store.clear();
		},
		key: (index: number) => [...store.keys()][index] ?? null,
		get length() {
			return store.size;
		},
	};
	Object.defineProperty(globalThis, "localStorage", { configurable: true, value: localStorage });
}

beforeEach(() => {
	stubStorage();
	window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
	vi.spyOn(nativeBridgeClient.aiEdition, "save").mockImplementation(async (document) => ({
		success: true,
		document,
	}));
});

afterEach(() => {
	cleanup();
	useProjectStore.getState().clear();
	vi.restoreAllMocks();
});

function renderWithProject(legacyEditor: Record<string, unknown> = {}) {
	const document = { ...createEmptyDocument({ projectId: "p", title: "t" }), legacyEditor };
	useProjectStore.setState({ projectId: "p", document });
	return render(
		<I18nProvider>
			<CursorPane />
		</I18nProvider>,
	);
}

async function applyUploadedHotspot(locale = "en") {
	const dialog = await screen.findByRole("dialog");
	const image = dialog.querySelector("button img");
	if (!image) throw new Error("Missing uploaded image");
	fireEvent.load(image);
	fireEvent.click(
		within(dialog).getByRole("button", { name: locale === "de" ? "Übernehmen" : "Apply" }),
	);
	await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}

describe("CursorPane theme picker", () => {
	it("shows the original cursor themes beside the default", () => {
		expect(CURSOR_THEMES).toHaveLength(6);
		render(
			<I18nProvider>
				<CursorPane />
			</I18nProvider>,
		);
		expect(screen.getByRole("button", { name: "Default" })).toBeTruthy();
		for (const theme of CURSOR_THEMES) {
			const button = screen.getByRole("button", { name: theme.name });
			expect(button.querySelectorAll("img")).toHaveLength(1);
		}
	});

	it("opens a three-slot custom cursor upload panel from the plus button", () => {
		renderWithProject();
		fireEvent.click(screen.getByRole("button", { name: "Add custom cursor" }));
		const panel = screen.getByRole("group", { name: "Custom cursor" });
		expect(within(panel).getByRole("button", { name: "Arrow" })).toBeTruthy();
		expect(within(panel).getByRole("button", { name: "Hand" })).toBeTruthy();
		expect(within(panel).getByRole("button", { name: "Text" })).toBeTruthy();
		expect(panel.textContent).toBe("");
		for (const [label, kind] of [
			["Arrow", "arrow"],
			["Hand", "pointer"],
			["Text", "text"],
		] as const) {
			expect(
				within(panel)
					.getByRole("button", { name: label })
					.querySelector("img")
					?.getAttribute("src"),
			).toContain(DEFAULT_CURSOR_SPRITES[kind].assetPath);
		}
		fireEvent.pointerDown(within(panel).getByRole("button", { name: "Text" }));
		expect(screen.getByRole("group", { name: "Custom cursor" })).toBeTruthy();
		fireEvent.pointerDown(document.body);
		expect(screen.queryByRole("group", { name: "Custom cursor" })).toBeNull();
	});

	it("closes with Escape and toggles from the plus button", () => {
		renderWithProject();
		const add = screen.getByRole("button", { name: "Add custom cursor" });
		fireEvent.click(add);
		fireEvent.keyDown(document, { key: "Escape" });
		expect(screen.queryByRole("group", { name: "Custom cursor" })).toBeNull();
		fireEvent.click(add);
		fireEvent.pointerDown(add);
		fireEvent.click(add);
		expect(screen.queryByRole("group", { name: "Custom cursor" })).toBeNull();
	});

	it("uploads one image with a blank MIME type, then adds other states without losing it", async () => {
		const { container } = renderWithProject();
		fireEvent.click(screen.getByRole("button", { name: "Add custom cursor" }));
		const panel = screen.getByRole("group", { name: "Custom cursor" });
		const input = container.querySelector<HTMLInputElement>('input[type="file"]');
		if (!input) throw new Error("Missing cursor upload input");
		let uploads = 0;
		const upload = async (label: string, name: string, contents: string) => {
			uploads += 1;
			fireEvent.click(within(panel).getByRole("button", { name: label }));
			fireEvent.change(input, { target: { files: [new File([contents], name)] } });
			await applyUploadedHotspot();
			await waitFor(() => expect(nativeBridgeClient.aiEdition.save).toHaveBeenCalledTimes(uploads));
		};
		await upload("Arrow", "arrow.PNG", "arrow-image");
		const arrow = getEditorSettings(useProjectStore.getState().document).cursorCustomTheme.arrow;
		expect(arrow).toMatch(/^data:image\/png;base64,/);
		expect(screen.getByRole("button", { name: "Custom 1" }).getAttribute("aria-pressed")).toBe(
			"true",
		);
		await upload("Hand", "hand.png", "hand-image");
		await upload("Text", "text.jpg", "text-image");
		const theme = getEditorSettings(useProjectStore.getState().document).cursorCustomTheme;
		expect(theme.arrow).toBe(arrow);
		expect(theme.pointer).toMatch(/^data:image\/png;base64,/);
		expect(theme.text).toMatch(/^data:image\/jpeg;base64,/);
		await upload("Replace Arrow image", "replacement.png", "replacement-image");
		const replaced = getEditorSettings(useProjectStore.getState().document).cursorCustomTheme;
		expect(replaced.arrow).not.toBe(arrow);
		expect(replaced.pointer).toBe(theme.pointer);
		expect(replaced.text).toBe(theme.text);
		expect(screen.getAllByRole("button", { name: "Custom 1" })).toHaveLength(1);
		fireEvent.click(screen.getByRole("button", { name: "Default" }));
		await waitFor(() =>
			expect(getEditorSettings(useProjectStore.getState().document).cursorTheme).toBe("default"),
		);
		fireEvent.click(screen.getByRole("button", { name: "Custom 1" }));
		await waitFor(() =>
			expect(getEditorSettings(useProjectStore.getState().document).cursorTheme).toMatch(
				/^custom:/,
			),
		);
		expect(getEditorSettings(useProjectStore.getState().document).cursorCustomTheme).toEqual(
			replaced,
		);
	});

	it("removes one custom image while keeping the other images and the selected style", async () => {
		const arrow = "data:image/png;base64,YXJyb3c=";
		const pointer = "data:image/png;base64,aGFuZA==";
		renderWithProject({ cursorTheme: "custom", cursorCustomTheme: { arrow, pointer } });
		fireEvent.click(screen.getByRole("button", { name: "Custom 1" }));
		fireEvent.click(screen.getByRole("button", { name: "Remove Hand image" }));
		await waitFor(() => {
			const settings = getEditorSettings(useProjectStore.getState().document);
			expect(settings.cursorCustomTheme).toEqual({ arrow });
			expect(settings.cursorTheme).toBe("custom");
		});
		expect(screen.queryByRole("button", { name: "Remove Hand image" })).toBeNull();
		expect(
			within(screen.getByRole("group", { name: "Custom cursor" })).getByRole("button", {
				name: "Hand",
			}),
		).toBeTruthy();
	});

	it("removes the last custom image safely", async () => {
		renderWithProject({
			cursorTheme: "custom",
			cursorCustomTheme: { text: "data:image/png;base64,dGV4dA==" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Custom 1" }));
		fireEvent.click(screen.getByRole("button", { name: "Remove Text image" }));
		await waitFor(() => {
			const settings = getEditorSettings(useProjectStore.getState().document);
			expect(settings.cursorCustomTheme).toEqual({});
			expect(settings.cursorTheme).toBe("default");
		});
		expect(screen.queryByRole("button", { name: "Custom 1" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Delete custom cursor set" })).toBeNull();
	});

	it("deletes the whole custom cursor set without closing the upload panel", async () => {
		renderWithProject({
			cursorTheme: "custom",
			cursorCustomTheme: {
				arrow: "data:image/png;base64,YXJyb3c=",
				pointer: "data:image/png;base64,aGFuZA==",
			},
		});
		fireEvent.click(screen.getByRole("button", { name: "Custom 1" }));
		fireEvent.click(screen.getByRole("button", { name: "Delete custom cursor set" }));
		await waitFor(() =>
			expect(getEditorSettings(useProjectStore.getState().document).cursorCustomTheme).toEqual({}),
		);
		expect(getEditorSettings(useProjectStore.getState().document).cursorTheme).toBe("default");
		expect(screen.queryByRole("button", { name: "Custom 1" })).toBeNull();
		expect(
			within(screen.getByRole("group", { name: "Custom cursor" })).getAllByRole("button"),
		).toHaveLength(3);
	});

	it.each([
		"en",
		"de",
	])("keeps five independent sets and localized stable numbers in %s", async (locale) => {
		window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
		const { container } = renderWithProject();
		const addLabel = locale === "de" ? "Eigenen Cursor hinzufügen" : "Add custom cursor";
		const name = (number: number) =>
			`${locale === "de" ? "Benutzerdefiniert" : "Custom"} ${number}`;
		const input = container.querySelector<HTMLInputElement>('input[type="file"]');
		if (!input) throw new Error("Missing cursor upload input");
		for (let number = 1; number <= 5; number++) {
			fireEvent.click(screen.getByRole("button", { name: addLabel }));
			fireEvent.click(screen.getByRole("button", { name: locale === "de" ? "Pfeil" : "Arrow" }));
			fireEvent.change(input, { target: { files: [new File([`image-${number}`], "arrow.png")] } });
			await applyUploadedHotspot(locale);
			await waitFor(() => expect(screen.getByRole("button", { name: name(number) })).toBeTruthy());
		}
		const original = getEditorSettings(useProjectStore.getState().document).cursorCustomThemes;
		expect(original).toHaveLength(5);
		expect(new Set(original.map((entry) => entry.id)).size).toBe(5);
		fireEvent.click(screen.getByRole("button", { name: name(2) }));
		fireEvent.click(
			screen.getByRole("button", {
				name: locale === "de" ? "Bild für Pfeil ersetzen" : "Replace Arrow image",
			}),
		);
		fireEvent.change(input, { target: { files: [new File(["replacement"], "arrow.png")] } });
		await applyUploadedHotspot(locale);
		await waitFor(() =>
			expect(
				getEditorSettings(useProjectStore.getState().document).cursorCustomTheme.arrow,
			).not.toBe(original[1].images.arrow),
		);
		expect(
			getEditorSettings(useProjectStore.getState().document).cursorCustomThemes.filter(
				(entry) => entry.id !== original[1].id,
			),
		).toEqual(original.filter((entry) => entry.id !== original[1].id));
		fireEvent.click(
			screen.getByRole("button", {
				name:
					locale === "de" ? "Benutzerdefiniertes Cursor-Set löschen" : "Delete custom cursor set",
			}),
		);
		await waitFor(() => expect(screen.queryByRole("button", { name: name(2) })).toBeNull());
		for (const number of [1, 3, 4, 5])
			expect(screen.getByRole("button", { name: name(number) })).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: name(1) }));
		expect(getEditorSettings(useProjectStore.getState().document).cursorCustomTheme).toEqual(
			original[0].images,
		);
	});

	it("does not persist a new upload until its hotspot is applied", async () => {
		const { container } = renderWithProject();
		fireEvent.click(screen.getByRole("button", { name: "Add custom cursor" }));
		fireEvent.click(
			within(screen.getByRole("group", { name: "Custom cursor" })).getByRole("button", {
				name: "Hand",
			}),
		);
		fireEvent.change(container.querySelector('input[type="file"]')!, {
			target: { files: [new File(["image"], "hand.png")] },
		});
		await screen.findByRole("dialog", { name: "Hotspot: Hand" });
		expect(nativeBridgeClient.aiEdition.save).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(getEditorSettings(useProjectStore.getState().document).cursorCustomThemes).toEqual([]);
	});

	it("edits an existing point without replacing its image and cancels a subsequent draft", async () => {
		const arrow = "data:image/png;base64,QQ==";
		renderWithProject({ cursorTheme: "custom", cursorCustomTheme: { arrow } });
		fireEvent.click(screen.getByRole("button", { name: "Custom 1" }));
		fireEvent.click(screen.getByRole("button", { name: "Edit Arrow hotspot" }));
		fireEvent.load(screen.getByRole("img", { name: "Arrow" }));
		fireEvent.change(screen.getByRole("spinbutton", { name: "X %" }), { target: { value: "75" } });
		fireEvent.click(screen.getByRole("button", { name: "Apply" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(getEditorSettings(useProjectStore.getState().document).cursorCustomTheme).toEqual({
			arrow,
		});
		expect(
			getEditorSettings(useProjectStore.getState().document).cursorCustomHotspots.arrow?.x,
		).toBe(0.75);
		fireEvent.click(screen.getByRole("button", { name: "Edit Arrow hotspot" }));
		fireEvent.change(screen.getByRole("spinbutton", { name: "X %" }), { target: { value: "10" } });
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(
			getEditorSettings(useProjectStore.getState().document).cursorCustomHotspots.arrow?.x,
		).toBe(0.75);
	});

	it("rejects unsupported files without changing the project", () => {
		const error = vi.spyOn(toast, "error");
		const { container } = renderWithProject();
		const input = container.querySelector<HTMLInputElement>('input[type="file"]');
		if (!input) throw new Error("Missing cursor upload input");
		fireEvent.change(input, {
			target: { files: [new File(["text"], "fake.png", { type: "text/plain" })] },
		});
		expect(error).toHaveBeenCalled();
		expect(nativeBridgeClient.aiEdition.save).not.toHaveBeenCalled();
		expect(getEditorSettings(useProjectStore.getState().document).cursorCustomTheme).toEqual({});
	});
});
