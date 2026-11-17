// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliDoneResult } from "@/lib/cliContracts";
import { CliSourcesRunner } from "./CliSourcesRunner";

describe("CliSourcesRunner", () => {
	const getSources = vi.fn();
	const cliDone = vi.fn(async (_result: CliDoneResult) => undefined);

	beforeEach(() => {
		vi.useFakeTimers();
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		getSources.mockReset();
		cliDone.mockClear();
		window.electronAPI = {
			cliGetRequest: vi.fn(async () => ({ kind: "sources" })),
			getSources,
			cliDone,
		} as unknown as typeof window.electronAPI;
		Object.defineProperty(navigator, "mediaDevices", {
			configurable: true,
			value: { enumerateDevices: vi.fn(async () => []) },
		});
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("reports an unanswered screen-sharing picker as a possible timeout cause", async () => {
		getSources.mockReturnValue(new Promise(() => undefined));
		render(<CliSourcesRunner />);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(19_999);
		});
		expect(cliDone).not.toHaveBeenCalled();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1);
		});
		expect(cliDone).toHaveBeenCalledExactlyOnceWith({
			success: false,
			error: expect.stringContaining("system screen-sharing picker"),
		});
		expect(cliDone.mock.calls[0][0].error).toContain("20000ms");
		expect(cliDone.mock.calls[0][0].error).not.toContain("usually means");
	});

	it("preserves a capture backend error that arrives before the deadline", async () => {
		getSources.mockRejectedValue(new Error("ScreenCastPortal failed: cancelled"));
		render(<CliSourcesRunner />);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(cliDone).toHaveBeenCalledExactlyOnceWith({
			success: false,
			error: expect.stringContaining("ScreenCastPortal failed: cancelled"),
		});
	});

	it("keeps successful source enumeration unchanged", async () => {
		getSources.mockResolvedValue([
			{ id: "screen:0:0", name: "Display 1" },
			{ id: "window:123:0", name: "Example window" },
		]);
		render(<CliSourcesRunner />);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(cliDone).toHaveBeenCalledExactlyOnceWith({
			success: true,
			sources: {
				displays: [{ index: 0, id: "screen:0:0", name: "Display 1" }],
				windows: [{ id: "window:123:0", name: "Example window" }],
				microphones: [],
				cameras: [],
				microphoneLabelsUnavailable: false,
				cameraLabelsUnavailable: false,
			},
		});
	});
});
