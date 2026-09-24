import type { BrowserWindow } from "electron";
import { describe, expect, it, vi } from "vitest";
import type { NativeBridgeState } from "../store";
import { ProjectService } from "./projectService";

function makeService() {
	const ok = { success: true } as never;
	const options = {
		store: { setProjectContext: vi.fn() } as unknown as NativeBridgeState,
		getCurrentProjectPath: () => null,
		getCurrentVideoPath: () => null,
		saveProjectFile: vi.fn(async () => ok),
		loadProjectFile: vi.fn(async () => ok),
		loadCurrentProjectFile: vi.fn(async () => ok),
		loadProjectFileFromPath: vi.fn(async () => ok),
		setCurrentVideoPath: vi.fn(),
		getCurrentVideoPathResult: vi.fn(),
		clearCurrentVideoPath: vi.fn(),
	};
	return { service: new ProjectService(options), options };
}

describe("ProjectService file panels (#743)", () => {
	it("passes the requesting window through, so the save panel is owned by it", async () => {
		const { service, options } = makeService();
		const editor = {} as BrowserWindow;

		await service.saveProjectFile({}, "name", undefined, editor);

		expect(options.saveProjectFile).toHaveBeenCalledWith({}, "name", undefined, editor);
	});

	it("passes the requesting window through to the open panel", async () => {
		const { service, options } = makeService();
		const editor = {} as BrowserWindow;

		await service.loadProjectFile("/folder", editor);

		expect(options.loadProjectFile).toHaveBeenCalledWith("/folder", editor);
	});
});
