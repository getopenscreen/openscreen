import { beforeEach, describe, expect, it, vi } from "vitest";

const syncProject = vi.hoisted(() => vi.fn());
vi.mock("@/native/client", () => ({ nativeBridgeClient: { drive: { syncProject } } }));

import { syncProjectVideoToDrive } from "./driveSync";

beforeEach(() => {
	syncProject.mockReset();
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("syncProjectVideoToDrive", () => {
	it("reports an upload", async () => {
		syncProject.mockResolvedValue({ uploaded: true, state: null });
		expect(await syncProjectVideoToDrive("proj_1", "Demo", "/v/take.mp4")).toBe("uploaded");
		expect(syncProject).toHaveBeenCalledWith("proj_1", "Demo", "/v/take.mp4");
	});

	it("reports nothing to do while sync is off", async () => {
		syncProject.mockResolvedValue({ uploaded: false, state: null });
		expect(await syncProjectVideoToDrive("proj_1", "Demo", "/v/take.mp4")).toBe("skipped");
	});

	it("turns an upload the main process failed into 'failed', never a throw", async () => {
		syncProject.mockRejectedValue(Object.assign(new Error("quota"), { code: "INTERNAL_ERROR" }));
		expect(await syncProjectVideoToDrive("proj_1", "Demo", "/v/take.mp4")).toBe("failed");
	});

	it("treats a bridge without Drive as nothing to sync to", async () => {
		syncProject.mockRejectedValue(Object.assign(new Error("no drive"), { code: "UNAVAILABLE" }));
		expect(await syncProjectVideoToDrive("proj_1", "Demo", "/v/take.mp4")).toBe("skipped");
		syncProject.mockRejectedValue(new Error("Native bridge unavailable"));
		expect(await syncProjectVideoToDrive("proj_1", "Demo", "/v/take.mp4")).toBe("skipped");
	});
});
