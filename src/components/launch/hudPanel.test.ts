import type { ToastT } from "sonner";
import { describe, expect, it } from "vitest";
import { EMPTY_HUD_PANEL_STATE, hudPanelHasContent, toHudPanelToasts } from "./hudPanel";

describe("hudPanelHasContent", () => {
	it("is false only when nothing at all is open", () => {
		expect(hudPanelHasContent(EMPTY_HUD_PANEL_STATE)).toBe(false);
		expect(
			hudPanelHasContent({
				...EMPTY_HUD_PANEL_STATE,
				toasts: [{ id: 1, type: "default", title: "Saved", revision: 1 }],
			}),
		).toBe(true);
		expect(
			hudPanelHasContent({
				...EMPTY_HUD_PANEL_STATE,
				languageMenu: { locales: ["en"], activeLocale: "en", names: { en: "English" } },
			}),
		).toBe(true);
	});
});

describe("toHudPanelToasts", () => {
	it("carries a toast across as plain data: text, type, duration and the action's label", () => {
		const toasts: ToastT[] = [
			{
				id: "perm",
				type: "warning",
				title: "Needs a permission",
				description: () => "Open the settings",
				duration: 10_000,
				action: { label: "Open", onClick: () => undefined },
			},
		];
		expect(toHudPanelToasts(toasts)).toEqual([
			{
				id: "perm",
				type: "warning",
				title: "Needs a permission",
				description: "Open the settings",
				duration: 10_000,
				actionLabel: "Open",
				revision: expect.any(Number),
			},
		]);
	});

	it("leaves out dismissed toasts and maps sonner's internal types to the default look", () => {
		const toasts: ToastT[] = [
			{ id: 1, type: "normal", title: "Plain" },
			{ id: 2, type: "error", title: "Gone", delete: true },
		];
		expect(toHudPanelToasts(toasts)).toEqual([
			{ id: 1, type: "default", title: "Plain", revision: expect.any(Number) },
		]);
	});

	it("drops markup it cannot send between windows rather than sending an object", () => {
		const toasts: ToastT[] = [{ id: 1, title: { type: "b" } as unknown as ToastT["title"] }];
		expect(toHudPanelToasts(toasts)).toEqual([
			{ id: 1, type: "default", title: "", revision: expect.any(Number) },
		]);
	});

	// useSonner builds a new object for a toast each time it is published, same-id replacement
	// included, and keeps every other toast's object: the revision follows the object.
	it("gives a republished toast a new revision and an untouched one the same", () => {
		const first: ToastT = { id: "copy", type: "default", title: "Copied" };
		const other: ToastT = { id: "saved", type: "success", title: "Saved" };
		const [a, b] = toHudPanelToasts([first, other]);
		const [aAgain, bAgain] = toHudPanelToasts([first, other]);
		expect(aAgain.revision).toBe(a.revision);
		expect(bAgain.revision).toBe(b.revision);

		const [replaced] = toHudPanelToasts([{ ...first }, other]);
		expect(replaced.revision).not.toBe(a.revision);
	});
});
