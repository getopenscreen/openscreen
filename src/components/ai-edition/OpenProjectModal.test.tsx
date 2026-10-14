// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import type { AiEditionProjectRecordingsResult } from "@/native/contracts";
import { OpenProjectModal } from "./Modals";

// The Trash is called the Recycle Bin on Windows: pin the platform rather than inherit the host's.
const platform = vi.hoisted(() => ({ current: "darwin" as NodeJS.Platform }));
vi.mock("@/utils/platformUtils", () => ({ getPlatform: () => platform.current }));

function renderWithI18n(ui: ReactElement) {
	return render(<I18nProvider>{ui}</I18nProvider>);
}

const projects = [
	{ id: "proj_one", title: "First project", updatedAt: "2026-08-12T10:00:00.000Z" },
	{ id: "proj_two", title: "Second project", updatedAt: "2026-08-13T10:00:00.000Z" },
];

const noRecordings: AiEditionProjectRecordingsResult = {
	success: true,
	count: 0,
	sizeBytes: 0,
	keptFor: [],
};

function renderModal(
	overrides: {
		onSelect?: () => void;
		onDelete?: (...args: unknown[]) => Promise<{ trashFailed?: boolean } | undefined>;
		recordings?: AiEditionProjectRecordingsResult;
	} = {},
) {
	const onSelect = overrides.onSelect ?? vi.fn();
	const onDelete = vi.fn(overrides.onDelete ?? (async () => undefined));
	const loadRecordings = vi.fn(async () => overrides.recordings ?? noRecordings);
	renderWithI18n(
		<OpenProjectModal
			open={true}
			onClose={vi.fn()}
			projects={projects}
			activeProjectId={null}
			onSelect={onSelect}
			onDelete={onDelete}
			loadRecordings={loadRecordings}
			onBrowse={vi.fn()}
		/>,
	);
	return { onSelect, onDelete, loadRecordings };
}

const ownRecordings: AiEditionProjectRecordingsResult = {
	success: true,
	count: 2,
	sizeBytes: 24 * 1024 * 1024,
	keptFor: [],
};

describe("OpenProjectModal delete", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
		platform.current = "darwin";
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

		expect(onDelete).toHaveBeenCalledWith("proj_two", "keep");
	});

	it("offers to trash the project's recordings, off by default", async () => {
		const { onDelete, loadRecordings } = renderModal({ recordings: ownRecordings });

		fireEvent.click(screen.getAllByRole("button", { name: /delete project/i })[0]);
		expect(loadRecordings).toHaveBeenCalledWith("proj_one");
		const toggle = await screen.findByRole("button", {
			name: /move its recordings to the trash \(24 MB\)/i,
		});
		expect(toggle).toHaveAttribute("aria-pressed", "false");
		expect(screen.queryByText(/recordings are kept/i)).not.toBeInTheDocument();

		fireEvent.click(toggle);
		fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));

		await waitFor(() => expect(onDelete).toHaveBeenCalledWith("proj_one", "trash"));
	});

	it("says Recycle Bin on Windows", async () => {
		platform.current = "win32";
		renderModal({ recordings: ownRecordings });

		fireEvent.click(screen.getAllByRole("button", { name: /delete project/i })[0]);

		expect(await screen.findByText(/recycle bin \(24 MB\)/i)).toBeInTheDocument();
	});

	it("names the projects whose recordings are kept", async () => {
		renderModal({ recordings: { ...ownRecordings, keptFor: ["Demo v2"] } });

		fireEvent.click(screen.getAllByRole("button", { name: /delete project/i })[0]);

		expect(await screen.findByText(/used by Demo v2 are kept/i)).toBeInTheDocument();
	});

	it("asks to delete permanently when the Trash refuses", async () => {
		const { onDelete } = renderModal({
			recordings: ownRecordings,
			onDelete: async (_id, disposal) => (disposal === "trash" ? { trashFailed: true } : undefined),
		});

		fireEvent.click(screen.getAllByRole("button", { name: /delete project/i })[0]);
		fireEvent.click(await screen.findByRole("button", { name: /move its recordings/i }));
		fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));

		const permanent = await screen.findByRole("button", { name: /delete permanently/i });
		expect(screen.getByText(/couldn't move the recordings to the trash/i)).toBeInTheDocument();
		fireEvent.click(permanent);

		await waitFor(() => expect(onDelete).toHaveBeenLastCalledWith("proj_one", "permanent"));
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
