// Deleting a project takes the recordings disposal from the renderer, and every value but
// "trash" would remove files for good, so the bridge accepts only the known ones.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeBridgeResponse } from "../../src/native/contracts";
import {
	type NativeBridgeContext,
	type NativeBridgeHandle,
	registerNativeBridgeHandlers,
} from "./nativeBridge";

const electron = vi.hoisted(() => ({ handle: vi.fn() }));
vi.mock("electron", () => ({
	app: { getAppPath: () => "", isPackaged: false },
	ipcMain: { handle: electron.handle, removeHandler: vi.fn() },
	shell: {},
}));
const compositor = vi.hoisted(() => ({
	nextId: 1,
	createView: vi.fn(() => compositor.nextId++),
	destroyView: vi.fn(),
}));
vi.mock("../native-bridge/services/compositorViewService", () => ({
	CompositorViewService: class {
		createView = compositor.createView;
		destroyView = compositor.destroyView;
	},
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
let invokeRaw: (sender: unknown, request: unknown) => Promise<NativeBridgeResponse>;
let handle: NativeBridgeHandle;

beforeEach(() => {
	electron.handle.mockClear();
	service.deleteProject.mockClear();
	compositor.createView.mockClear();
	compositor.destroyView.mockClear();
	compositor.nextId = 1;
	handle = registerNativeBridgeHandlers({
		getPlatform: () => "linux",
		getAiEditionDocuments: () => ({}),
		getAiEditionLlmConfig: () => ({}),
	} as unknown as NativeBridgeContext);
	const handler = electron.handle.mock.calls[0]?.[1] as (
		event: unknown,
		request: unknown,
	) => Promise<NativeBridgeResponse>;
	invokeRaw = (sender, request) => handler({ sender }, request);
	invoke = (payload) =>
		invokeRaw({}, { domain: "aiEdition", action: "document.delete", payload, requestId: "r" });
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

	it("exposes deleteProject and destroyViewsForSender on the returned handle", async () => {
		const onceHandlers: Record<string, () => void> = {};
		const sender = {
			id: 42,
			once: vi.fn((event: string, cb: () => void) => {
				onceHandlers[event] = cb;
			}),
		};
		await invokeRaw(sender, {
			domain: "compositor",
			action: "createView",
			payload: { rect: { x: 0, y: 0, width: 100, height: 100 } },
			requestId: "c1",
		});
		await invokeRaw(sender, {
			domain: "compositor",
			action: "createView",
			payload: { rect: { x: 0, y: 0, width: 100, height: 100 } },
			requestId: "c2",
		});
		await invokeRaw(sender, {
			domain: "compositor",
			action: "destroyView",
			payload: { id: 1 },
			requestId: "d1",
		});
		expect(compositor.destroyView).toHaveBeenCalledTimes(1);

		handle.destroyViewsForSender(42);
		expect(compositor.destroyView).toHaveBeenCalledWith(2);
		expect(compositor.destroyView).toHaveBeenCalledTimes(2);

		await handle.deleteProject("p2", "trash");
		expect(service.deleteProject).toHaveBeenCalledWith("p2", "trash");
	});
});
