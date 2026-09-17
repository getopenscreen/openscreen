import { describe, expect, it, vi } from "vitest";
import { disableHttpCacheForDevServer } from "./dev-http-cache";

describe("disableHttpCacheForDevServer", () => {
	it("disables the HTTP cache when loading from a Vite dev server", () => {
		const commandLine = { appendSwitch: vi.fn() };
		disableHttpCacheForDevServer(commandLine, { VITE_DEV_SERVER_URL: "http://localhost:5173" });
		expect(commandLine.appendSwitch).toHaveBeenCalledTimes(1);
		expect(commandLine.appendSwitch).toHaveBeenCalledWith("disable-http-cache");
	});

	it("leaves the HTTP cache alone without a dev server", () => {
		const commandLine = { appendSwitch: vi.fn() };
		disableHttpCacheForDevServer(commandLine, {});
		expect(commandLine.appendSwitch).not.toHaveBeenCalled();
	});
});
