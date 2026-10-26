// Deleting a project takes the recordings disposal from the renderer, and every value but
// "trash" would remove files for good, so the bridge accepts only the known ones.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeBridgeResponse } from "../../src/native/contracts";
import { type NativeBridgeContext, registerNativeBridgeHandlers } from "./nativeBridge";

const electron = vi.hoisted(() => ({ handle: vi.fn() }));
vi.mock("electron", () => ({
	app: { getAppPath: () => "", isPackaged: false },
	ipcMain: { handle: electron.handle, removeHandler: vi.fn() },
	shell: {},
}));
vi.mock("../native-bridge/services/compositorViewService", () => ({
	CompositorViewService: class {},
}));

const service = vi.hoisted(() => ({
	deleteProject: vi.fn(async () => ({ success: true })),
}));
vi.mock("../native-bridge/services/aiEditionService", () => ({
	AiEditionService: class {
		deleteProject = service.deleteProject;
	},
}));

let invoke: (payload: unknown) => Promise<NativeBridgeResponse>;

beforeEach(() => {
	electron.handle.mockClear();
	service.deleteProject.mockClear();
	registerNativeBridgeHandlers({
		getPlatform: () => "linux",
		getAiEditionDocuments: () => ({}),
		getAiEditionLlmConfig: () => ({}),
	} as unknown as NativeBridgeContext);
	const handler = electron.handle.mock.calls[0]?.[1] as (
		event: unknown,
		request: unknown,
	) => Promise<NativeBridgeResponse>;
	invoke = (payload) =>
		handler(
			{ sender: {} },
			{ domain: "aiEdition", action: "document.delete", payload, requestId: "r" },
		);
});

describe("native bridge project delete", () => {
	it.each(["Trash", "delete", null, 1])("rejects recordings=%s as a bad request", async (value) => {
		const response = await invoke({ projectId: "p", recordings: value });

		expect(response.ok ? undefined : response.error?.code).toBe("INVALID_REQUEST");
		expect(service.deleteProject).not.toHaveBeenCalled();
	});

	it.each([undefined, "keep", "trash", "permanent"])("passes recordings=%s on", async (value) => {
		const response = await invoke({ projectId: "p", recordings: value });

		expect(response.ok).toBe(true);
		expect(service.deleteProject).toHaveBeenCalledWith("p", value);
	});
});
