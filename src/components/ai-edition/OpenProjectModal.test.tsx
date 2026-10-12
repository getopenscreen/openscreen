// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { OpenProjectModal } from "./Modals";

function renderWithI18n(ui: ReactElement) {
	return render(<I18nProvider>{ui}</I18nProvider>);
}

const projects = [
	{ id: "proj_one", title: "First project", updatedAt: "2026-08-12T10:00:00.000Z" },
	{ id: "proj_two", title: "Second project", updatedAt: "2026-08-13T10:00:00.000Z" },
];

function renderModal(overrides: { onSelect?: () => void; onDelete?: () => void } = {}) {
	const onSelect = overrides.onSelect ?? vi.fn();
	const onDelete = overrides.onDelete ?? vi.fn();
	renderWithI18n(
		<OpenProjectModal
			open={true}
			onClose={vi.fn()}
			projects={projects}
			activeProjectId={null}
			onSelect={onSelect}
			onDelete={onDelete}
			onBrowse={vi.fn()}
		/>,
	);
	return { onSelect, onDelete };
}

describe("OpenProjectModal delete", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("asks before deleting instead of deleting on the first click", () => {
		const { onDelete } = renderModal();

		fireEvent.click(screen.getAllByRole("button", { name: /delete project/i })[0]);

		expect(onDelete).not.toHaveBeenCalled();
		expect(screen.getByText(/recordings are kept/i)).toBeInTheDocument();
	});

	it("deletes the project the confirm was armed on", () => {
		const { onDelete } = renderModal();

		fireEvent.click(screen.getAllByRole("button", { name: /delete project/i })[1]);
		fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));

		expect(onDelete).toHaveBeenCalledWith("proj_two");
	});

	it("cancels back to the row", () => {
		const { onDelete } = renderModal();

		fireEvent.click(screen.getAllByRole("button", { name: /delete project/i })[0]);
		fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

		expect(onDelete).not.toHaveBeenCalled();
		expect(screen.getByText("First project")).toBeInTheDocument();
		expect(screen.queryByText(/recordings are kept/i)).not.toBeInTheDocument();
	});

	// The delete button sits next to the row's own button, not inside it — a
	// nested button would swallow the click that opens the project.
	it("still opens a project when the row is clicked", () => {
		const { onSelect } = renderModal();

		fireEvent.click(screen.getByText("First project"));

		expect(onSelect).toHaveBeenCalledWith("proj_one");
	});
});

describe("OpenProjectModal keyboard (#1135)", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("opens the only match of a search on Enter", () => {
		const { onSelect } = renderModal();
		const search = screen.getByRole("searchbox");

		fireEvent.change(search, { target: { value: "second" } });
		fireEvent.keyDown(search, { key: "Enter" });

		expect(onSelect).toHaveBeenCalledWith("proj_two");
	});

	it("highlights the first match of a search, and ↑↓ move the highlight", () => {
		const { onSelect } = renderModal();
		const search = screen.getByRole("searchbox");

		fireEvent.change(search, { target: { value: "project" } });
		const highlightedTitle = () =>
			document.querySelector('[aria-current="true"]')?.textContent ?? "";
		expect(highlightedTitle()).toContain("First project");

		fireEvent.keyDown(search, { key: "ArrowDown" });
		expect(highlightedTitle()).toContain("Second project");
		// The last row holds.
		fireEvent.keyDown(search, { key: "ArrowDown" });
		fireEvent.keyDown(search, { key: "Enter" });

		expect(onSelect).toHaveBeenCalledWith("proj_two");
	});

	it("leaves Enter on a focused row button to the button itself", () => {
		const { onSelect } = renderModal();

		const row = screen.getByText("Second project").closest("button") as HTMLButtonElement;
		fireEvent.keyDown(row, { key: "Enter" });

		expect(onSelect).not.toHaveBeenCalled();
	});
});
