// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import type { AiEditionProjectRecordingsResult } from "@/native/contracts";
import { type CloseProjectChoice, CloseProjectModal } from "./Modals";

const platform = vi.hoisted(() => ({ current: "darwin" as NodeJS.Platform }));
vi.mock("@/utils/platformUtils", () => ({ getPlatform: () => platform.current }));

const ownRecordings: AiEditionProjectRecordingsResult = {
	success: true,
	count: 1,
	sizeBytes: 24 * 1024 * 1024,
	keptFor: [],
	unreadable: 0,
};

const noRecordings: AiEditionProjectRecordingsResult = {
	success: true,
	count: 0,
	sizeBytes: 0,
	keptFor: [],
	unreadable: 0,
};

afterEach(() => {
	cleanup();
	platform.current = "darwin";
});

function renderCloseModal(opts: {
	dirty?: boolean;
	recordings?: AiEditionProjectRecordingsResult;
	onChoose?: (choice: CloseProjectChoice) => void;
	onClose?: () => void;
}) {
	const onChoose = opts.onChoose ?? vi.fn();
	const onClose = opts.onClose ?? vi.fn();
	const loadRecordings = vi.fn(async () => opts.recordings ?? ownRecordings);
	render(
		<I18nProvider>
			<CloseProjectModal
				open={true}
				onClose={onClose}
				projectId="proj_fresh"
				dirty={opts.dirty ?? false}
				loadRecordings={loadRecordings}
				onChoose={onChoose}
			/>
		</I18nProvider>,
	);
	return { onChoose, onClose, loadRecordings };
}

describe("CloseProjectModal", () => {
	it("shows Keep & Close when clean and Save & Close when dirty", async () => {
		const onChooseClean = vi.fn();
		renderCloseModal({ dirty: false, onChoose: onChooseClean });
		const keepBtn = await screen.findByRole("button", { name: "Keep & Close" });
		fireEvent.click(keepBtn);
		expect(onChooseClean).toHaveBeenCalledWith({ choice: "keep" });

		cleanup();

		const onChooseDirty = vi.fn();
		renderCloseModal({ dirty: true, onChoose: onChooseDirty });
		const saveBtn = await screen.findByRole("button", { name: "Save & Close" });
		fireEvent.click(saveBtn);
		expect(onChooseDirty).toHaveBeenCalledWith({ choice: "save" });
	});

	it("defaults recordings toggle ON (Trash on macOS, Recycle Bin on Windows) and sends trash", async () => {
		const onChoose = vi.fn();
		renderCloseModal({ recordings: ownRecordings, onChoose });

		const toggle = await screen.findByRole("button", {
			name: /move its recordings to the trash \(24 MB\)/i,
		});
		expect(toggle).toHaveAttribute("aria-pressed", "true");

		const discardBtn = screen.getByRole("button", { name: "Discard Project" });
		await waitFor(() => expect(discardBtn).not.toBeDisabled());
		fireEvent.click(discardBtn);
		expect(onChoose).toHaveBeenCalledWith({ choice: "discard-project", recordings: "trash" });

		cleanup();
		platform.current = "win32";
		renderCloseModal({ recordings: ownRecordings });
		expect(await screen.findByText(/recycle bin \(24 MB\)/i)).toBeInTheDocument();
	});

	it("sends keep when the user toggles recordings disposal off", async () => {
		const onChoose = vi.fn();
		renderCloseModal({ recordings: ownRecordings, onChoose });

		const toggle = await screen.findByRole("button", {
			name: /move its recordings to the trash \(24 MB\)/i,
		});
		fireEvent.click(toggle);
		expect(toggle).toHaveAttribute("aria-pressed", "false");

		fireEvent.click(screen.getByRole("button", { name: "Discard Project" }));
		expect(onChoose).toHaveBeenCalledWith({ choice: "discard-project", recordings: "keep" });
	});

	it("hides the toggle when no owned recordings exist and shows shared/unreadable notices", async () => {
		const onChoose = vi.fn();
		renderCloseModal({
			recordings: {
				success: true,
				count: 0,
				sizeBytes: 0,
				keptFor: ["Other Take"],
				unreadable: 1,
			},
			onChoose,
		});

		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Discard Project" })).not.toBeDisabled(),
		);
		expect(screen.queryByRole("button", { name: /move its recordings/i })).not.toBeInTheDocument();
		expect(screen.getByText(/Other Take/)).toBeInTheDocument();
		expect(screen.getByText(/couldn't be read/i)).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Discard Project" }));
		expect(onChoose).toHaveBeenCalledWith({ choice: "discard-project", recordings: "keep" });
	});

	it("resolves cancel on Cancel button and on backdrop/Escape close", async () => {
		const onChoose = vi.fn();
		const onClose = vi.fn();
		renderCloseModal({ recordings: noRecordings, onChoose, onClose });

		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Discard Project" })).not.toBeDisabled(),
		);
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(onChoose).toHaveBeenCalledWith({ choice: "cancel" });

		fireEvent.keyDown(document, { key: "Escape" });
		expect(onClose).toHaveBeenCalled();
	});

	it("wraps Tab and Shift+Tab focus inside the modal", async () => {
		renderCloseModal({ recordings: noRecordings });
		const dialog = screen.getByRole("dialog");
		const closeBtn = screen.getByRole("button", { name: "Close" });
		const keepBtn = await screen.findByRole("button", { name: "Keep & Close" });
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Discard Project" })).not.toBeDisabled(),
		);

		keepBtn.focus();
		expect(document.activeElement).toBe(keepBtn);
		fireEvent.keyDown(dialog, { key: "Tab" });
		expect(document.activeElement).toBe(closeBtn);

		fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
		expect(document.activeElement).toBe(keepBtn);
	});
});
