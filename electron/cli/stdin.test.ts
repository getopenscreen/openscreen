import { afterEach, describe, expect, it, vi } from "vitest";
import { openStdin } from "./stdin";

describe("openStdin", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("keeps Node's own stdin outside Windows", () => {
		vi.stubGlobal("process", { ...process, platform: "linux", stdin: "the-stdin" });
		expect(openStdin()).toBe("the-stdin");
	});
});
