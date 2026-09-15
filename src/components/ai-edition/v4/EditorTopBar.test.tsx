// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ProjectNameField is a private helper inside EditorTopBar, so reach it through
// the public topbar instead. The translator echoes keys; assertions read better
// against keys than against prose that drifts with copy edits.
//
// The locale is settable rather than pinned to "en": "en" sorts first among the
// thirteen, so with it fixed there is no way to tell "opens on the language you
// are in" apart from "opens on the first row".
const i18n = vi.hoisted(() => ({ locale: "en", setLocale: vi.fn() }));
vi.mock("@/contexts/I18nContext", () => ({
	useI18n: () => ({ locale: i18n.locale, setLocale: i18n.setLocale }),
	useScopedT: () => (key: string) => key,
}));

vi.mock("@/hooks/useTheme", () => ({
	useTheme: () => ({ theme: "dark", toggle: () => {} }),
}));

import { getAvailableLocales } from "@/i18n/loader";
import { EditorTopBar } from "./EditorTopBar";

/** Row order is the loader's, not this file's guess at it. */
const getLocaleIndex = (code: string) => getAvailableLocales().indexOf(code);

beforeEach(() => {
	i18n.locale = "en";
	i18n.setLocale.mockClear();
});
afterEach(cleanup);

const noop = () => {};

/** The project-name / rename button, named by its aria-label rather than by the
 *  title it paints — the title is what changes between these cases. */
const nameButton = () => screen.getByRole("button", { name: "topbar.renameProject" });

function renderTopBar(projectTitle: string | null, dirty = false) {
	const onRename = vi.fn();
	const onShowAbout = vi.fn();
	const onCheckForUpdates = vi.fn();
	const onOpenSettings = vi.fn();
	const onOpenProviderSettings = vi.fn();
	render(
		<EditorTopBar
			mode="edit"
			onModeChange={noop}
			projectTitle={projectTitle}
			dirty={dirty}
			canExport={false}
			chatOpen={false}
			actions={{
				openProject: noop,
				newProject: noop,
				save: noop,
				export: noop,
				openSettings: onOpenSettings,
				renameProject: onRename,
				toggleChat: noop,
				openProviderSettings: onOpenProviderSettings,
				showAbout: onShowAbout,
				checkForUpdates: onCheckForUpdates,
			}}
		/>,
	);
	return { onRename, onShowAbout, onCheckForUpdates, onOpenSettings, onOpenProviderSettings };
}

/** The menu reads two separate channels, and they answer different questions: `getAppInfo` for
 *  the version, `canCheckForUpdatesNow` for the full update veto (see EditorTopBar). Neither
 *  exists in jsdom. Returns the cleanup so a stub cannot leak into the next test. */
function stubElectronAPI(info: { version: string; canCheckForUpdates: boolean }) {
	(window as unknown as { electronAPI?: unknown }).electronAPI = {
		getAppInfo: () => Promise.resolve(info),
		canCheckForUpdatesNow: () => Promise.resolve(info.canCheckForUpdates),
	};
	return () => {
		(window as unknown as { electronAPI?: unknown }).electronAPI = undefined;
	};
}

describe("ProjectNameField (issue #180)", () => {
	it("renders the project title on the button", () => {
		renderTopBar("Demo Project");
		expect(screen.getByRole("button", { name: "topbar.renameProject" })).toHaveTextContent(
			"Demo Project",
		);
	});

	it("shows a placeholder and is disabled when no project is loaded", () => {
		renderTopBar(null);
		const button = screen.getByRole("button", { name: "topbar.renameProject" });
		expect(button).toBeDisabled();
		expect(button).toHaveTextContent("topbar.noProject");
	});

	it("swaps to an input pre-filled with the title on click and selects it", () => {
		renderTopBar("Demo Project");
		fireEvent.click(screen.getByRole("button", { name: "topbar.renameProject" }));
		const input = screen.getByRole("textbox") as HTMLInputElement;
		expect(input.value).toBe("Demo Project");
		// The text is selected on focus, so a keystroke replaces the whole title.
		fireEvent.change(input, { target: { value: "Renamed" } });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(input).not.toBeInTheDocument();
	});

	it("commits a typed title on Enter via onRename", () => {
		const { onRename } = renderTopBar("Demo Project");
		fireEvent.click(screen.getByRole("button", { name: "topbar.renameProject" }));
		const input = screen.getByRole("textbox");
		fireEvent.change(input, { target: { value: "Renamed" } });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(onRename).toHaveBeenCalledWith("Renamed");
	});

	it("commits on blur when the title was edited", () => {
		const { onRename } = renderTopBar("Demo Project");
		fireEvent.click(screen.getByRole("button", { name: "topbar.renameProject" }));
		const input = screen.getByRole("textbox");
		fireEvent.change(input, { target: { value: "Blurred rename" } });
		fireEvent.blur(input);
		expect(onRename).toHaveBeenCalledWith("Blurred rename");
	});

	it("rejects an empty / whitespace-only rename", () => {
		const { onRename } = renderTopBar("Demo Project");
		fireEvent.click(screen.getByRole("button", { name: "topbar.renameProject" }));
		const input = screen.getByRole("textbox");
		fireEvent.change(input, { target: { value: "   " } });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(onRename).not.toHaveBeenCalled();
	});

	it("cancels on Escape without calling onRename", () => {
		const { onRename } = renderTopBar("Demo Project");
		fireEvent.click(screen.getByRole("button", { name: "topbar.renameProject" }));
		const input = screen.getByRole("textbox");
		fireEvent.change(input, { target: { value: "Half-typed" } });
		fireEvent.keyDown(input, { key: "Escape" });
		expect(onRename).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "topbar.renameProject" })).toHaveTextContent(
			"Demo Project",
		);
	});

	it("keeps the rename button in the no-drag region (regression for #180)", () => {
		// The pre-fix button used `style={{ all: "unset" }}` which clobbered the
		// topbar's `-webkit-app-region: no-drag` rule. In the Electron build the
		// button then becomes a window-drag handle and the click never fires the
		// onClick handler. The CSS module class must keep the no-drag property.
		renderTopBar("Demo Project");
		const button = screen.getByRole("button", { name: "topbar.renameProject" });
		// jsdom doesn't honour `-webkit-app-region`, so assert the marker
		// indirectly via the inline-style rule we removed: the pre-fix button
		// had `all: unset`; if any element still has it, the regression is back.
		expect(button.getAttribute("style") ?? "").not.toMatch(/all\s*:\s*unset/);
	});
});

describe("AppMenu", () => {
	it("hangs the menu on the brand rather than adding a control to the bar", () => {
		renderTopBar("Demo Project");
		const trigger = screen.getByRole("button", { name: /OpenScreen/ });
		expect(trigger).toHaveAttribute("aria-haspopup", "menu");
		expect(trigger).toHaveAttribute("aria-expanded", "false");
		// The whole point of the wordmark-as-trigger: no menu until asked for.
		expect(screen.queryByRole("menu")).not.toBeInTheDocument();
	});

	it("keeps the trigger a real button, which is the only thing that makes it clickable", () => {
		// `.topbar button, .topbar input, .topbar select` is the ENTIRE no-drag opt-out in
		// EditorShellV4.module.css. A brand rendered as a <span> or a <div role="button"> sits
		// on the window-drag region and the OS eats the click — the #180 failure, one control
		// over. Same reason `all: unset` is banned here.
		renderTopBar("Demo Project");
		const trigger = screen.getByRole("button", { name: /OpenScreen/ });
		expect(trigger.tagName).toBe("BUTTON");
		expect(trigger.getAttribute("style") ?? "").not.toMatch(/all\s*:\s*unset/);
	});

	it("opens on click and offers shortcuts, AI settings and about", () => {
		renderTopBar("Demo Project");
		fireEvent.click(screen.getByRole("button", { name: /OpenScreen/ }));
		expect(screen.getByRole("menu")).toBeInTheDocument();
		// Exact names: the translator echoes keys, and both settings rows are labelled with a
		// `…title` key, so a /title/ match would hit two items and pin neither.
		expect(screen.getByRole("menuitem", { name: "title" })).toBeInTheDocument();
		expect(screen.getByRole("menuitem", { name: "providerSettings.title" })).toBeInTheDocument();
		expect(screen.getByRole("menuitem", { name: /actions\.about/ })).toBeInTheDocument();
	});

	// Issue #420: the AI dialog used to be openable only from the chat panel, which mounts in
	// Edit mode with the panel expanded. The row is unconditional here — its dialog is mounted
	// in App.tsx, above every mode — so the menu does not lie in Media and Rec.
	it("opens the AI settings dialog and closes behind itself", () => {
		const { onOpenProviderSettings, onOpenSettings } = renderTopBar("Demo Project");
		fireEvent.click(screen.getByRole("button", { name: /OpenScreen/ }));
		fireEvent.click(screen.getByRole("menuitem", { name: "providerSettings.title" }));
		expect(onOpenProviderSettings).toHaveBeenCalledTimes(1);
		// Distinct from the shortcuts row above it, which is the dialog it would be confused with.
		expect(onOpenSettings).not.toHaveBeenCalled();
		expect(screen.queryByRole("menu")).not.toBeInTheDocument();
	});

	it("routes About to the main process and closes behind itself", () => {
		const { onShowAbout } = renderTopBar("Demo Project");
		fireEvent.click(screen.getByRole("button", { name: /OpenScreen/ }));
		fireEvent.click(screen.getByRole("menuitem", { name: /actions\.about/ }));
		expect(onShowAbout).toHaveBeenCalledTimes(1);
		expect(screen.queryByRole("menu")).not.toBeInTheDocument();
	});

	it("closes on Escape", () => {
		renderTopBar("Demo Project");
		fireEvent.click(screen.getByRole("button", { name: /OpenScreen/ }));
		fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
		expect(screen.queryByRole("menu")).not.toBeInTheDocument();
	});

	it("hides Check for Updates when the install channel owns updates", async () => {
		// No electronAPI at all in jsdom, which lands on the same branch as a Store/Flathub/Snap
		// build answering false, and as a check refused mid-take: no item, rather than a button
		// that silently does nothing.
		renderTopBar("Demo Project");
		fireEvent.click(screen.getByRole("button", { name: /OpenScreen/ }));
		expect(
			screen.queryByRole("menuitem", { name: /actions\.checkForUpdates/ }),
		).not.toBeInTheDocument();
	});

	it("offers Check for Updates where the app owns its own updates", async () => {
		const restore = stubElectronAPI({ version: "9.9.9", canCheckForUpdates: true });
		try {
			const { onCheckForUpdates } = renderTopBar("Demo Project");
			fireEvent.click(screen.getByRole("button", { name: /OpenScreen/ }));
			const item = await screen.findByRole("menuitem", { name: /actions\.checkForUpdates/ });
			fireEvent.click(item);
			expect(onCheckForUpdates).toHaveBeenCalledTimes(1);
		} finally {
			restore();
		}
	});

	it("shows the running version on the About row, for pasting into a bug report", async () => {
		const restore = stubElectronAPI({ version: "9.9.9", canCheckForUpdates: false });
		try {
			renderTopBar("Demo Project");
			fireEvent.click(screen.getByRole("button", { name: /OpenScreen/ }));
			expect(await screen.findByText("9.9.9")).toBeInTheDocument();
		} finally {
			restore();
		}
	});
});

describe("EditorTopBar responsive affordances and tooltips", () => {
	it("provides accessible name and title on the export button", () => {
		renderTopBar("Demo Project");
		const exportBtn = screen.getByRole("button", { name: "topbar.export" });
		expect(exportBtn).toBeInTheDocument();
		expect(exportBtn).toHaveAttribute("title", "topbar.export");
	});

	it("provides title tooltips for mode switch tabs", () => {
		renderTopBar("Demo Project");
		const tabs = screen.getAllByRole("tab");
		expect(tabs).toHaveLength(3);
		expect(tabs[0]).toHaveAttribute("title", "topbar.modes.media");
		expect(tabs[1]).toHaveAttribute("title", "topbar.modes.edit");
		expect(tabs[2]).toHaveAttribute("title", "topbar.modes.rec");
	});

	// The "Saved"/"Unsaved" badge is gone: unsaved work is marked on the document
	// name instead. What has to survive that is the announcement -- the marker
	// itself is decoration, and the rename button's aria-label swallows anything
	// nested inside it, so a silent dot would drop the state out of the a11y tree
	// altogether.
	it("says nothing about saving while the document is clean", () => {
		renderTopBar("Demo Project");
		expect(screen.queryByText("topbar.unsaved")).not.toBeInTheDocument();
		expect(screen.queryByText("topbar.saved")).not.toBeInTheDocument();
		// Not "no description at all": the hover title describes the button on every
		// bar. What has to be absent is the unsaved state.
		expect(nameButton()).not.toHaveAccessibleDescription("topbar.unsaved");
	});

	// The accessible DESCRIPTION, not the mere presence of the text: a span sitting
	// loose beside the button is announced when a reader walks past it and stays
	// silent on the focus that matters, which is indistinguishable from the bug.
	it("announces the unsaved state once the document is modified", () => {
		renderTopBar("Demo Project", true);
		expect(nameButton()).toHaveAccessibleDescription("topbar.unsaved");
	});

	// A project-less bar reads "No project", which an unsaved marker beside it
	// would contradict.
	it("keeps the unsaved marker off a bar with no project", () => {
		renderTopBar(null, true);
		expect(screen.queryByText("topbar.unsaved")).not.toBeInTheDocument();
		expect(nameButton()).not.toHaveAccessibleDescription();
	});

	it("names every mode tab independently of the width its label is painted at", () => {
		renderTopBar("Demo Project");
		const tabs = screen.getAllByRole("tab");
		expect(tabs.map((tab) => tab.getAttribute("aria-label"))).toEqual([
			"topbar.modes.media",
			"topbar.modes.edit",
			"topbar.modes.rec",
		]);
		// Each tab carries exactly one glyph, which is decorative: the name above
		// is what a screen reader reads.
		for (const tab of tabs) {
			const icons = tab.querySelectorAll("svg");
			expect(icons).toHaveLength(1);
			expect(icons[0]).toHaveAttribute("aria-hidden");
		}
	});

	it("keeps the brand trigger accessible by label and title even when text collapses", () => {
		renderTopBar("Demo Project");
		const brandBtn = screen.getByRole("button", { name: "OpenScreen" });
		expect(brandBtn).toHaveAttribute("title", "OpenScreen");
		expect(brandBtn).toHaveAttribute("aria-label", "OpenScreen");
	});

	it("provides accessible language toggle with short code and options", () => {
		renderTopBar("Demo Project");
		const langBtn = screen.getByRole("button", { name: "topbar.changeLanguage" });
		expect(langBtn).toBeInTheDocument();
		expect(langBtn).toHaveTextContent("EN");
		fireEvent.click(langBtn);
		expect(screen.getByText("English")).toBeInTheDocument();
	});
});

describe("EditorTopBar language menu", () => {
	const openMenu = () => {
		renderTopBar("Demo Project");
		const trigger = screen.getByRole("button", { name: "topbar.changeLanguage" });
		fireEvent.click(trigger);
		return { trigger, items: () => screen.getAllByRole("menuitemradio") };
	};

	// It announced itself with aria-pressed, which says "this control is a toggle
	// that is currently on" — it opens a menu.
	it("announces itself as a menu trigger, not as a pressed toggle", () => {
		renderTopBar("Demo Project");
		const trigger = screen.getByRole("button", { name: "topbar.changeLanguage" });
		expect(trigger).toHaveAttribute("aria-haspopup", "menu");
		expect(trigger).toHaveAttribute("aria-expanded", "false");
		expect(trigger).not.toHaveAttribute("aria-pressed");
		fireEvent.click(trigger);
		expect(trigger).toHaveAttribute("aria-expanded", "true");
	});

	// The chosen language used to be marked by colour alone, which does not reach
	// a screen reader and did not survive the contrast fix either.
	it("marks the current language to something other than the eye", () => {
		i18n.locale = "fr";
		const { items } = openMenu();
		const checked = items().filter((i) => i.getAttribute("aria-checked") === "true");
		expect(checked).toHaveLength(1);
		expect(checked[0]).toHaveTextContent("Français");
	});

	it("opens onto the language in use rather than the top of the list", () => {
		i18n.locale = "fr";
		const { items } = openMenu();
		expect(document.activeElement).toBe(items()[getLocaleIndex("fr")]);
		expect(document.activeElement).toHaveTextContent("Français");
	});

	it("closes on Escape and hands focus back to the trigger", () => {
		const { trigger } = openMenu();
		fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
		expect(screen.queryByRole("menu")).not.toBeInTheDocument();
		expect(document.activeElement).toBe(trigger);
	});

	it("walks the list with the arrow keys, wrapping at both ends", () => {
		const { items } = openMenu();
		const menu = screen.getByRole("menu");
		const all = items();
		expect(document.activeElement).toBe(all[0]);
		fireEvent.keyDown(menu, { key: "ArrowDown" });
		expect(document.activeElement).toBe(all[1]);
		fireEvent.keyDown(menu, { key: "ArrowUp" });
		fireEvent.keyDown(menu, { key: "ArrowUp" });
		expect(document.activeElement).toBe(all[all.length - 1]);
		fireEvent.keyDown(menu, { key: "Home" });
		expect(document.activeElement).toBe(all[0]);
		fireEvent.keyDown(menu, { key: "End" });
		expect(document.activeElement).toBe(all[all.length - 1]);
	});

	it("jumps to a language by its typed name", () => {
		openMenu();
		fireEvent.keyDown(screen.getByRole("menu"), { key: "f" });
		expect(document.activeElement).toHaveTextContent("Français");
	});

	// Typing the native name only reaches the ones a Latin keyboard can produce,
	// so the locale code has to match too or 日本語 is unreachable by keyboard.
	it("jumps by locale code for the names a keyboard cannot type", () => {
		const { items } = openMenu();
		fireEvent.keyDown(screen.getByRole("menu"), { key: "j" });
		expect(document.activeElement).toBe(items()[getLocaleIndex("ja-JP")]);
	});

	// Consecutive keys inside the window accumulate, which is what makes "po"
	// reach Português instead of stopping at the first p.
	it("accumulates consecutive keystrokes into one search", () => {
		const { items } = openMenu();
		const menu = screen.getByRole("menu");
		fireEvent.keyDown(menu, { key: "p" });
		expect(document.activeElement).toBe(items()[getLocaleIndex("pt-BR")]);
		fireEvent.keyDown(menu, { key: "o" });
		expect(document.activeElement).toBe(items()[getLocaleIndex("pt-BR")]);
	});

	it("picks a language and closes, returning focus to the trigger", () => {
		const { trigger, items } = openMenu();
		fireEvent.click(items()[getLocaleIndex("fr")]);
		expect(i18n.setLocale).toHaveBeenCalledWith("fr");
		expect(screen.queryByRole("menu")).not.toBeInTheDocument();
		expect(document.activeElement).toBe(trigger);
	});

	// Language and theme are the bar's two app-wide preferences, and they are meant
	// to read as one pair at its right end. Nothing about either button says where it
	// belongs, so without this the language selector drifts back among the file
	// actions the first time someone reorders the header.
	it("seats the language selector immediately before the theme toggle", () => {
		renderTopBar("Demo Project");
		const langBtn = screen.getByRole("button", { name: "topbar.changeLanguage" });
		const themeBtn = screen.getByRole("button", { name: "topbar.toggleTheme" });
		// The selector is wrapped in its own popover anchor, so the sibling that
		// precedes the theme button is that anchor, not the button itself.
		expect(themeBtn.previousElementSibling).toBe(langBtn.closest("div"));
		expect(
			langBtn.compareDocumentPosition(themeBtn) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});
});
