import "@testing-library/jest-dom";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	buildEditorMenuModel,
	EditorMenuBar,
	type EditorMenuBarProps,
	formatShiftShortcut,
	formatShortcut,
} from "./EditorMenuBar";

const LABELS: Record<string, string> = {
	"common.actions.file": "File",
	"common.actions.edit": "Edit",
	"common.actions.view": "View",
	"common.actions.quit": "Quit",
	"common.actions.undo": "Undo",
	"common.actions.redo": "Redo",
	"common.actions.reload": "Reload",
	"dialogs.unsavedChanges.newProject": "New Project",
	"dialogs.unsavedChanges.loadProject": "Load Project…",
	"dialogs.unsavedChanges.saveProject": "Save Project…",
	"dialogs.unsavedChanges.saveProjectAs": "Save Project As…",
};

function makeProps(overrides: Partial<EditorMenuBarProps> = {}): EditorMenuBarProps {
	return {
		isMac: false,
		t: (key: string) => LABELS[key] ?? key,
		onNewProject: vi.fn(),
		onLoadProject: vi.fn(),
		onSaveProject: vi.fn(),
		onSaveProjectAs: vi.fn(),
		onQuit: vi.fn(),
		onUndo: vi.fn(),
		onRedo: vi.fn(),
		onReload: vi.fn(),
		canUndo: true,
		canRedo: true,
		...overrides,
	};
}

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("formatShortcut", () => {
	it("uses Ctrl on non-mac and the ⌘ symbol on mac", () => {
		expect(formatShortcut(false, "N")).toBe("Ctrl+N");
		expect(formatShortcut(true, "N")).toBe("⌘N");
	});

	it("formats shift combos per platform", () => {
		expect(formatShiftShortcut(false, "S")).toBe("Ctrl+Shift+S");
		expect(formatShiftShortcut(true, "S")).toBe("⌘⇧S");
	});
});

describe("buildEditorMenuModel", () => {
	it("returns the File, Edit and View menus with translated labels", () => {
		const model = buildEditorMenuModel(makeProps());
		expect(model.map((m) => m.id)).toEqual(["file", "edit", "view"]);
		expect(model.map((m) => m.label)).toEqual(["File", "Edit", "View"]);
	});

	it("wires each File item to its handler", () => {
		const props = makeProps();
		const [file] = buildEditorMenuModel(props);
		const byId = Object.fromEntries(file.items.map((i) => [i.id, i]));

		byId["new-project"].onSelect();
		byId["load-project"].onSelect();
		byId["save-project"].onSelect();
		byId["save-project-as"].onSelect();
		byId.quit.onSelect();

		expect(props.onNewProject).toHaveBeenCalledOnce();
		expect(props.onLoadProject).toHaveBeenCalledOnce();
		expect(props.onSaveProject).toHaveBeenCalledOnce();
		expect(props.onSaveProjectAs).toHaveBeenCalledOnce();
		expect(props.onQuit).toHaveBeenCalledOnce();
	});

	it("marks Quit as a destructive item after a separator", () => {
		const [file] = buildEditorMenuModel(makeProps());
		const quit = file.items.find((i) => i.id === "quit");
		expect(quit).toMatchObject({ danger: true, separatorBefore: true });
	});

	it("shows Ctrl-based shortcut hints on non-mac", () => {
		const model = buildEditorMenuModel(makeProps({ isMac: false }));
		const shortcuts = Object.fromEntries(
			model.flatMap((m) => m.items).map((i) => [i.id, i.shortcut]),
		);
		expect(shortcuts).toMatchObject({
			"new-project": "Ctrl+N",
			"load-project": "Ctrl+O",
			"save-project": "Ctrl+S",
			"save-project-as": "Ctrl+Shift+S",
			quit: "Ctrl+Q",
			undo: "Ctrl+Z",
			redo: "Ctrl+Y",
			reload: "Ctrl+R",
		});
	});

	it("shows ⌘-based shortcut hints on mac (redo uses ⌘⇧Z)", () => {
		const model = buildEditorMenuModel(makeProps({ isMac: true }));
		const shortcuts = Object.fromEntries(
			model.flatMap((m) => m.items).map((i) => [i.id, i.shortcut]),
		);
		expect(shortcuts).toMatchObject({
			"new-project": "⌘N",
			"save-project-as": "⌘⇧S",
			undo: "⌘Z",
			redo: "⌘⇧Z",
			reload: "⌘R",
		});
	});

	it("disables Undo/Redo according to canUndo/canRedo", () => {
		const model = buildEditorMenuModel(makeProps({ canUndo: false, canRedo: false }));
		const edit = model.find((m) => m.id === "edit");
		expect(edit?.items.find((i) => i.id === "undo")?.disabled).toBe(true);
		expect(edit?.items.find((i) => i.id === "redo")?.disabled).toBe(true);

		const enabled = buildEditorMenuModel(makeProps({ canUndo: true, canRedo: true }));
		const editEnabled = enabled.find((m) => m.id === "edit");
		expect(editEnabled?.items.find((i) => i.id === "undo")?.disabled).toBe(false);
		expect(editEnabled?.items.find((i) => i.id === "redo")?.disabled).toBe(false);
	});
});

describe("<EditorMenuBar />", () => {
	// Radix relies on pointer-capture / scroll APIs jsdom does not implement.
	beforeAll(() => {
		Element.prototype.hasPointerCapture = vi.fn(() => false);
		Element.prototype.releasePointerCapture = vi.fn();
		Element.prototype.scrollIntoView = vi.fn();
	});

	it("renders the three top-level menu triggers", () => {
		render(<EditorMenuBar {...makeProps()} />);
		expect(screen.getByRole("button", { name: "File" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "View" })).toBeInTheDocument();
	});

	it("opens the File menu and invokes the handler for a selected item", async () => {
		const user = userEvent.setup();
		const props = makeProps();
		render(<EditorMenuBar {...props} />);

		await user.click(screen.getByRole("button", { name: "File" }));

		expect(await screen.findByText("New Project")).toBeInTheDocument();
		expect(screen.getByText("Ctrl+N")).toBeInTheDocument();

		await user.click(screen.getByText("Save Project…"));
		expect(props.onSaveProject).toHaveBeenCalledOnce();
	});

	it("renders a disabled Undo item when canUndo is false", async () => {
		const user = userEvent.setup();
		const props = makeProps({ canUndo: false });
		render(<EditorMenuBar {...props} />);

		await user.click(screen.getByRole("button", { name: "Edit" }));

		const undoItem = await screen.findByRole("menuitem", { name: /Undo/ });
		expect(undoItem).toHaveAttribute("aria-disabled", "true");
	});
});
