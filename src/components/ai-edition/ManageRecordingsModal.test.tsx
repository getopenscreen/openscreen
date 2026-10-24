// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import type {
	AiEditionRecording,
	AiEditionRecordingsDeleteResult,
	AiEditionRecordingsListResult,
} from "@/native/contracts";
import { ManageRecordingsModal } from "./ManageRecordingsModal";

// The Trash is called the Recycle Bin on Windows: pin the platform rather than inherit the host's.
const platform = vi.hoisted(() => ({ current: "darwin" as NodeJS.Platform }));
vi.mock("@/utils/platformUtils", () => ({ getPlatform: () => platform.current }));

const MB = 1024 * 1024;

function recording(stem: string, usedBy: string[], sizeBytes: number): AiEditionRecording {
	return {
		id: `/recordings/${stem}`,
		stem,
		files: [`/recordings/${stem}.mp4`, `/recordings/${stem}.mp4.cursor.json`],
		sizeBytes,
		recordedAt: Date.UTC(2026, 9, 1),
		usedBy,
	};
}

const used = recording("recording-1", ["Demo"], 10 * MB);
const unused = recording("recording-2", [], 20 * MB);

function renderModal(
	overrides: {
		listing?: AiEditionRecordingsListResult;
		deleteRecordings?: (...args: unknown[]) => Promise<AiEditionRecordingsDeleteResult>;
	} = {},
) {
	const listing = overrides.listing ?? {
		success: true,
		recordings: [used, unused],
		unreadable: 0,
	};
	const loadRecordings = vi.fn(async () => listing);
	const deleteRecordings = vi.fn(overrides.deleteRecordings ?? (async () => ({ success: true })));
	const onReveal = vi.fn();
	render(
		<I18nProvider>
			<ManageRecordingsModal
				open={true}
				onClose={vi.fn()}
				loadRecordings={loadRecordings}
				deleteRecordings={deleteRecordings}
				onReveal={onReveal}
			/>
		</I18nProvider>,
	);
	return { loadRecordings, deleteRecordings, onReveal };
}

describe("ManageRecordingsModal", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
		platform.current = "darwin";
	});

	it("lists each recording with its size and who uses it", async () => {
		renderModal();

		expect(await screen.findByText("Used by Demo")).toBeInTheDocument();
		expect(screen.getByText("Not used by any project")).toBeInTheDocument();
		expect(screen.getByText("20 MB")).toBeInTheDocument();
		expect(screen.getByText("30 MB in total")).toBeInTheDocument();
	});

	it("selects only the unused ones, and trashes them without a warning", async () => {
		const { deleteRecordings } = renderModal();

		fireEvent.click(await screen.findByRole("button", { name: "Select unused" }));
		expect(screen.getByText("1 selected · 20 MB")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Delete" }));

		expect(screen.getByText(/selected recordings \(20 MB\) to the Trash/)).toBeInTheDocument();
		expect(screen.queryByText(/will lose that media/)).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Move to Trash" }));

		await waitFor(() =>
			expect(deleteRecordings).toHaveBeenCalledWith(["/recordings/recording-2"], "trash"),
		);
	});

	it("names the projects that lose media when a used recording is selected", async () => {
		renderModal();

		fireEvent.click(await screen.findByRole("checkbox", { name: /Used by Demo/ }));
		fireEvent.click(screen.getByRole("button", { name: "Delete" }));

		expect(
			screen.getByText("Some are used by Demo, which will lose that media."),
		).toBeInTheDocument();
	});

	it("asks to delete permanently when the Trash refuses", async () => {
		const { deleteRecordings } = renderModal({
			deleteRecordings: async (_ids, disposal) =>
				disposal === "trash" ? { success: false, trashFailed: true } : { success: true },
		});

		fireEvent.click(await screen.findByRole("button", { name: "Select all" }));
		fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		fireEvent.click(screen.getByRole("button", { name: "Move to Trash" }));

		const permanent = await screen.findByRole("button", { name: /delete permanently/i });
		fireEvent.click(permanent);

		await waitFor(() =>
			expect(deleteRecordings).toHaveBeenLastCalledWith(
				["/recordings/recording-1", "/recordings/recording-2"],
				"permanent",
			),
		);
	});

	it("says Recycle Bin on Windows", async () => {
		platform.current = "win32";
		renderModal();

		fireEvent.click(await screen.findByRole("button", { name: "Select unused" }));
		fireEvent.click(screen.getByRole("button", { name: "Delete" }));

		expect(screen.getByRole("button", { name: "Move to Recycle Bin" })).toBeInTheDocument();
	});

	it("warns that usage is uncertain while a project file does not parse", async () => {
		renderModal({ listing: { success: true, recordings: [unused], unreadable: 1 } });

		expect(await screen.findByText(/marked unused may still be in use/)).toBeInTheDocument();
	});

	it("shows the screen video in its folder", async () => {
		const { onReveal } = renderModal();

		const reveal = await screen.findAllByRole("button", { name: "Show in folder" });
		fireEvent.click(reveal[1]);

		expect(onReveal).toHaveBeenCalledWith("/recordings/recording-2.mp4");
	});
});
