// Deleting a project takes the recordings disposal from the renderer, and every value but
// "trash" would remove files for good, so the bridge accepts only the known ones. Deleting takes
// from the recordings manager is held to the same rule.

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
	deleteRecordings: vi.fn(async () => ({ success: true })),
}));
vi.mock("../native-bridge/services/aiEditionService", () => ({
	AiEditionService: class {
		deleteProject = service.deleteProject;
		deleteRecordings = service.deleteRecordings;
	},
}));

let invoke: (payload: unknown, action?: string) => Promise<NativeBridgeResponse>;

beforeEach(() => {
	electron.handle.mockClear();
	service.deleteProject.mockClear();
	service.deleteRecordings.mockClear();
	registerNativeBridgeHandlers({
		getPlatform: () => "linux",
		getAiEditionDocuments: () => ({}),
		getAiEditionLlmConfig: () => ({}),
	} as unknown as NativeBridgeContext);
	const handler = electron.handle.mock.calls[0]?.[1] as (
		event: unknown,
		request: unknown,
	) => Promise<NativeBridgeResponse>;
	invoke = (payload, action = "document.delete") =>
		handler({ sender: {} }, { domain: "aiEdition", action, payload, requestId: "r" });
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

describe("native bridge recordings delete", () => {
	it.each([
		{ ids: ["a"], disposal: undefined },
		{ ids: ["a"], disposal: "keep" },
		{ ids: ["a"], disposal: "Trash" },
		{ ids: "a", disposal: "trash" },
		{ ids: [1], disposal: "trash" },
		{ disposal: "permanent" },
	])("rejects %o as a bad request", async (payload) => {
		const response = await invoke(payload, "recordings.delete");

		expect(response.ok ? undefined : response.error?.code).toBe("INVALID_REQUEST");
		expect(service.deleteRecordings).not.toHaveBeenCalled();
	});

	it.each(["trash", "permanent"])("passes disposal=%s on", async (disposal) => {
		const response = await invoke({ ids: ["a", "b"], disposal }, "recordings.delete");

		expect(response.ok).toBe(true);
		expect(service.deleteRecordings).toHaveBeenCalledWith(["a", "b"], disposal, undefined);
	});

	it("passes the open document on, for the service to refuse its takes", async () => {
		const openDocument = { project: { id: "p" } };
		await invoke({ ids: ["a"], disposal: "trash", openDocument }, "recordings.delete");

		expect(service.deleteRecordings).toHaveBeenCalledWith(["a"], "trash", openDocument);
	});
});
