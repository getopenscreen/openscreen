import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeBridgeResponse } from "../../src/native/contracts";
import type { GoogleDriveService } from "../drive/google-drive-service";
import { type NativeBridgeContext, registerNativeBridgeHandlers } from "./nativeBridge";

const electron = vi.hoisted(() => ({ handle: vi.fn() }));
vi.mock("electron", () => ({
	app: { getAppPath: () => "", isPackaged: false },
	ipcMain: { handle: electron.handle, removeHandler: vi.fn() },
	shell: {},
}));
// The bridge builds these at registration; none of them is under test here.
vi.mock("../native-bridge/services/compositorViewService", () => ({
	CompositorViewService: class {},
}));
vi.mock("../native-bridge/services/aiEditionService", () => ({
	AiEditionService: class {},
}));

const drive = {
	getStatus: vi.fn(() => ({ connected: false })),
	syncProject: vi.fn(async () => ({ uploaded: true, state: null })),
	setVisibility: vi.fn(async () => ({ visibility: "anyone" })),
	unsync: vi.fn(async () => undefined),
	setSyncEnabled: vi.fn(async () => ({ syncEnabled: false })),
};

function register(withDrive: boolean) {
	electron.handle.mockClear();
	registerNativeBridgeHandlers({
		getPlatform: () => "linux",
		getAiEditionDocuments: () => ({}),
		getAiEditionLlmConfig: () => ({}),
		getStylePresets: () => ({}),
		getGoogleDrive: withDrive ? () => drive as unknown as GoogleDriveService : undefined,
	} as unknown as NativeBridgeContext);
	const handler = electron.handle.mock.calls[0]?.[1] as (
		event: unknown,
		request: unknown,
	) => Promise<NativeBridgeResponse>;
	return (request: unknown) => handler({ sender: {} }, request);
}

let invoke: (request: unknown) => Promise<NativeBridgeResponse>;
beforeEach(() => {
	for (const fn of Object.values(drive)) fn.mockClear();
	invoke = register(true);
});

describe("native bridge: drive", () => {
	it("passes a valid sync request through", async () => {
		const response = await invoke({
			domain: "drive",
			action: "syncProject",
			payload: { projectId: "proj_1", title: "Demo", path: "/videos/take.mp4" },
		});
		expect(response.ok).toBe(true);
		expect(drive.syncProject).toHaveBeenCalledWith("proj_1", "Demo", "/videos/take.mp4");
	});

	it.each([
		{ projectId: "../etc", title: "Demo", path: "/videos/take.mp4" },
		{ projectId: "proj_1", title: "Demo", path: "relative/take.mp4" },
		{ projectId: "proj_1", title: 3, path: "/videos/take.mp4" },
	])("refuses a malformed sync request %#", async (payload) => {
		const response = await invoke({ domain: "drive", action: "syncProject", payload });
		expect(response).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
		expect(drive.syncProject).not.toHaveBeenCalled();
	});

	it("only accepts the two visibilities", async () => {
		const bad = await invoke({
			domain: "drive",
			action: "setVisibility",
			payload: { projectId: "proj_1", visibility: "public" },
		});
		expect(bad).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
		const good = await invoke({
			domain: "drive",
			action: "setVisibility",
			payload: { projectId: "proj_1", visibility: "anyone" },
		});
		expect(good.ok).toBe(true);
	});

	it("checks the sync flag's type", async () => {
		const response = await invoke({
			domain: "drive",
			action: "setSyncEnabled",
			payload: { enabled: "yes" },
		});
		expect(response).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
	});

	it("answers UNAVAILABLE where there is no Drive service", async () => {
		const response = await register(false)({ domain: "drive", action: "getStatus" });
		expect(response).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
	});
});
