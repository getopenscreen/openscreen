import { describe, expect, it, vi } from "vitest";
import { createWebGLContextLostHandler } from "@/components/video-editor/VideoPlayback";

describe("createWebGLContextLostHandler", () => {
	it("calls preventDefault on the lost event so Chromium can attempt restoration", () => {
		const regenerate = vi.fn();
		const handler = createWebGLContextLostHandler({ generation: 0, regenerate });

		const event = new Event("webglcontextlost");
		const preventDefaultSpy = vi.spyOn(event, "preventDefault");
		handler(event);

		expect(preventDefaultSpy).toHaveBeenCalledOnce();
	});

	it("triggers the regenerate callback so React can rebuild the Pixi app", () => {
		const regenerate = vi.fn();
		const handler = createWebGLContextLostHandler({ generation: 0, regenerate });

		handler(new Event("webglcontextlost"));

		expect(regenerate).toHaveBeenCalledOnce();
	});

	it("logs the generation captured at handler construction time", () => {
		const regenerate = vi.fn();
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const handler = createWebGLContextLostHandler({ generation: 7, regenerate });

		handler(new Event("webglcontextlost"));

		expect(warnSpy).toHaveBeenCalledWith(
			"[VideoPlayback] WebGL context lost, recreating Pixi app",
			{ generation: 7 },
		);
		warnSpy.mockRestore();
	});
});
