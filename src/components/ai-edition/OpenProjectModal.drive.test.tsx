// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import type { DriveProjectState } from "@/native/contracts";
import { OpenProjectModal, type ProjectDriveActions } from "./Modals";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/utils/platformUtils", () => ({ getPlatform: () => "darwin" }));

const projects = [
	{ id: "proj_synced", title: "Synced project", updatedAt: "2026-11-10T10:00:00.000Z" },
	{ id: "proj_local", title: "Local project", updatedAt: "2026-11-11T10:00:00.000Z" },
];

const synced: DriveProjectState = {
	projectId: "proj_synced",
	fileId: "file-1",
	webViewLink: "https://drive.google.com/file/d/file-1/view",
	visibility: "private",
	syncedAt: "2026-11-12T00:00:00.000Z",
	status: "synced",
	error: null,
};

function renderModal(states: Record<string, DriveProjectState> = { proj_synced: synced }) {
	const drive: ProjectDriveActions = {
		load: vi.fn(async () => states),
		setVisibility: vi.fn(async (_id, visibility) => ({ ...synced, visibility })),
		unsync: vi.fn(async () => ({ success: true })),
		copyLink: vi.fn(async () => undefined),
	};
	render(
		<I18nProvider>
			<OpenProjectModal
				open={true}
				onClose={vi.fn()}
				projects={projects}
				activeProjectId={null}
				onSelect={vi.fn()}
				onDelete={vi.fn(async () => undefined)}
				loadRecordings={vi.fn(async () => ({
					success: true,
					count: 0,
					sizeBytes: 0,
					keptFor: [],
					unreadable: 0,
				}))}
				onBrowse={vi.fn()}
				drive={drive}
			/>
		</I18nProvider>,
	);
	return drive;
}

function rowOf(title: string): HTMLElement {
	const row = screen.getByText(title).closest("button")?.parentElement;
	if (!row) throw new Error(`no row for ${title}`);
	return row;
}

async function openMenu() {
	await waitFor(() => expect(screen.getByTestId("drive-badge")).toBeInTheDocument());
	fireEvent.click(screen.getByTestId("project-drive-menu"));
	return screen.getByRole("menu", { name: "Google Drive options" });
}

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("OpenProjectModal and Google Drive", () => {
	it("shows the Drive icon and menu only on the project that is in Drive", async () => {
		renderModal();
		await waitFor(() =>
			expect(within(rowOf("Synced project")).getByTestId("drive-badge")).toHaveAttribute(
				"aria-label",
				"Saved in Google Drive",
			),
		);
		expect(within(rowOf("Local project")).queryByTestId("drive-badge")).toBeNull();
		expect(within(rowOf("Local project")).queryByTestId("project-drive-menu")).toBeNull();
	});

	it("offers the three Drive actions in the row's menu", async () => {
		renderModal();
		const menu = await openMenu();
		expect(within(menu).getByRole("menuitem", { name: "Share drive link" })).toBeEnabled();
		expect(within(menu).getByRole("menuitem", { name: "Edit drive visibility" })).toBeEnabled();
		expect(within(menu).getByRole("menuitem", { name: "Unsync from drive" })).toBeEnabled();
	});

	it("copies the Drive link, and says when only its owner can open it", async () => {
		const drive = renderModal();
		fireEvent.click(within(await openMenu()).getByRole("menuitem", { name: "Share drive link" }));
		await waitFor(() => expect(drive.copyLink).toHaveBeenCalledWith(synced.webViewLink));
		await waitFor(() =>
			expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("Only you can open it")),
		);
	});

	it("changes who can view the video", async () => {
		const drive = renderModal();
		const menu = await openMenu();
		fireEvent.click(within(menu).getByRole("menuitem", { name: "Edit drive visibility" }));
		expect(within(menu).getByRole("menuitemradio", { name: "Only you" })).toHaveAttribute(
			"aria-checked",
			"true",
		);
		fireEvent.click(within(menu).getByRole("menuitemradio", { name: "Anyone with the link" }));
		await waitFor(() => expect(drive.setVisibility).toHaveBeenCalledWith("proj_synced", "anyone"));
		await waitFor(() => expect(toast.success).toHaveBeenCalled());
		// The next open reflects the change.
		fireEvent.click(screen.getByTestId("project-drive-menu"));
		fireEvent.click(screen.getByRole("menuitem", { name: "Edit drive visibility" }));
		expect(screen.getByRole("menuitemradio", { name: "Anyone with the link" })).toHaveAttribute(
			"aria-checked",
			"true",
		);
	});

	it("unsyncs, and the row loses its Drive icon", async () => {
		const drive = renderModal();
		fireEvent.click(within(await openMenu()).getByRole("menuitem", { name: "Unsync from drive" }));
		await waitFor(() => expect(drive.unsync).toHaveBeenCalledWith("proj_synced"));
		await waitFor(() => expect(screen.queryByTestId("drive-badge")).toBeNull());
	});

	it("shows an upload in progress, with no link to share yet", async () => {
		renderModal({
			proj_synced: { ...synced, fileId: null, webViewLink: null, status: "uploading" },
		});
		const menu = await openMenu();
		expect(screen.getByTestId("drive-badge")).toHaveAttribute("data-status", "uploading");
		expect(within(menu).getByRole("menuitem", { name: "Share drive link" })).toBeDisabled();
	});

	it("closes the menu, not the dialog, on Escape", async () => {
		renderModal();
		const menu = await openMenu();
		fireEvent.keyDown(within(menu).getByRole("menuitem", { name: "Share drive link" }), {
			key: "Escape",
		});
		expect(screen.queryByRole("menu")).toBeNull();
		expect(screen.getByRole("dialog")).toBeInTheDocument();
	});
});
