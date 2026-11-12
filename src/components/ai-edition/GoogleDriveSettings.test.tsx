// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import type { DriveStatus } from "@/native/contracts";
import { GoogleDriveSettings } from "./GoogleDriveSettings";

const drive = vi.hoisted(() => ({
	getStatus: vi.fn(),
	setClient: vi.fn(),
	connect: vi.fn(),
	disconnect: vi.fn(),
	setSyncEnabled: vi.fn(),
}));
vi.mock("@/native/client", () => ({ nativeBridgeClient: { drive } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const base: DriveStatus = {
	configured: false,
	clientFromEnv: false,
	clientId: null,
	connected: false,
	accountEmail: null,
	syncEnabled: false,
};
const configured: DriveStatus = { ...base, configured: true, clientId: "id.apps" };
const connected: DriveStatus = {
	...configured,
	connected: true,
	accountEmail: "me@example.com",
	syncEnabled: true,
};

function renderSettings() {
	render(
		<I18nProvider>
			<GoogleDriveSettings open={true} onClose={vi.fn()} />
		</I18nProvider>,
	);
}

beforeEach(() => {
	for (const fn of Object.values(drive)) fn.mockReset();
});
afterEach(cleanup);

describe("GoogleDriveSettings", () => {
	it("asks for the OAuth client first, then offers to connect", async () => {
		drive.getStatus.mockResolvedValue(base);
		drive.setClient.mockResolvedValue(configured);
		renderSettings();
		const id = await screen.findByLabelText("OAuth client ID");
		fireEvent.change(id, { target: { value: "id.apps" } });
		fireEvent.change(screen.getByLabelText("OAuth client secret"), { target: { value: "s3cret" } });
		fireEvent.click(screen.getByTestId("drive-save-client"));
		await waitFor(() => expect(drive.setClient).toHaveBeenCalledWith("id.apps", "s3cret"));
		expect(await screen.findByTestId("drive-connect")).toHaveTextContent("Connect to Google Drive");
	});

	it("does not ask for a client that came from the environment", async () => {
		drive.getStatus.mockResolvedValue({ ...base, configured: true, clientFromEnv: true });
		renderSettings();
		expect(await screen.findByTestId("drive-connect")).toBeInTheDocument();
		expect(screen.queryByLabelText("OAuth client ID")).toBeNull();
		expect(screen.queryByText("Change OAuth client")).toBeNull();
	});

	it("connects, and shows the account with sync on", async () => {
		drive.getStatus.mockResolvedValue(configured);
		drive.connect.mockResolvedValue(connected);
		renderSettings();
		fireEvent.click(await screen.findByTestId("drive-connect"));
		expect(await screen.findByText("Connected as me@example.com.")).toBeInTheDocument();
		expect(screen.getByTestId("drive-sync-toggle")).toHaveAttribute("aria-pressed", "true");
	});

	it("turns syncing off and on with the toggle", async () => {
		drive.getStatus.mockResolvedValue(connected);
		drive.setSyncEnabled.mockResolvedValue({ ...connected, syncEnabled: false });
		renderSettings();
		fireEvent.click(await screen.findByTestId("drive-sync-toggle"));
		await waitFor(() => expect(drive.setSyncEnabled).toHaveBeenCalledWith(false));
		await waitFor(() =>
			expect(screen.getByTestId("drive-sync-toggle")).toHaveAttribute("aria-pressed", "false"),
		);
	});

	it("disconnects", async () => {
		drive.getStatus.mockResolvedValue(connected);
		drive.disconnect.mockResolvedValue(configured);
		renderSettings();
		fireEvent.click(await screen.findByTestId("drive-disconnect"));
		expect(await screen.findByTestId("drive-connect")).toBeInTheDocument();
	});
});
