// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { LOCALE_STORAGE_KEY } from "@/i18n/config";
import { createEmptyDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { CursorPane } from "./RightPanes";

beforeEach(() => {
	const store = new Map<string, string>([[LOCALE_STORAGE_KEY, "en"]]);
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => void store.set(key, value),
			removeItem: (key: string) => void store.delete(key),
			clear: () => store.clear(),
			key: (i: number) => [...store.keys()][i] ?? null,
			get length() {
				return store.size;
			},
		},
	});
});

afterEach(() => {
	cleanup();
	useProjectStore.getState().clear();
});

function renderWithCursor(legacyEditor: Record<string, unknown>) {
	const document = createEmptyDocument({ projectId: "p", title: "t" });
	useProjectStore.setState({ projectId: "p", document: { ...document, legacyEditor } });
	render(
		<I18nProvider>
			<CursorPane />
		</I18nProvider>,
	);
}

const pressed = (group: string) =>
	screen.getByRole("group", { name: group }).querySelectorAll('button[aria-pressed="true"]');

describe("CursorPane named levels", () => {
	it("names the size and the click bounce instead of showing a number", () => {
		renderWithCursor({ cursorSize: 2, cursorClickBounce: 0 });
		expect([...pressed("Size")].map((b) => b.textContent)).toEqual(["Large"]);
		expect([...pressed("Click bounce")].map((b) => b.textContent)).toEqual(["None"]);
		expect(screen.queryByRole("slider", { name: "Size" })).toBeNull();
	});

	it("presses nothing for a stored value between two levels", () => {
		renderWithCursor({ cursorSize: 2.4 });
		expect(pressed("Size")).toHaveLength(0);
	});
});
