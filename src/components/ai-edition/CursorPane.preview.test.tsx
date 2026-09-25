// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { LOCALE_STORAGE_KEY } from "@/i18n/config";
import { CURSOR_THEMES } from "@/lib/cursor/cursorThemes";
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
});

afterEach(() => {
	cleanup();
});

describe("CursorPane theme picker", () => {
	it("is hidden while the default art is the only choice", () => {
		// Fails on purpose once a pack ships: the picker then has something to offer.
		expect(CURSOR_THEMES).toHaveLength(0);
		render(
			<I18nProvider>
				<CursorPane />
			</I18nProvider>,
		);
		expect(screen.queryByText("Cursor Style")).toBeNull();
		expect(screen.queryByRole("button", { name: "Default" })).toBeNull();
	});
});
