import { describe, expect, it } from "vitest";
import {
	describeChildProcessGone,
	describeRenderProcessGone,
	windowTypeOf,
} from "./processGoneLog";

describe("windowTypeOf", () => {
	it("names the window from its windowType, packaged or dev", () => {
		expect(
			windowTypeOf(
				"file:///Applications/Openscreen.app/Contents/Resources/app.asar/dist/index.html?windowType=hud-overlay",
			),
		).toBe("hud-overlay");
		expect(windowTypeOf("http://localhost:5173/?windowType=editor&project=x")).toBe("editor");
	});

	it("says unknown rather than printing a URL it cannot read", () => {
		expect(windowTypeOf("")).toBe("unknown");
		expect(windowTypeOf("file:///Users/someone/index.html")).toBe("unknown");
	});
});

describe("describeRenderProcessGone", () => {
	it("names the window and why its renderer went, never the path it was loaded from", () => {
		const line = describeRenderProcessGone(
			"file:///Users/someone/Openscreen.app/index.html?windowType=hud-overlay",
			{ reason: "crashed", exitCode: 11 },
		);
		expect(line).toBe("[app] the hud-overlay window's renderer is gone (crashed, exit code 11)");
		expect(line).not.toContain("/Users/");
	});
});

describe("describeChildProcessGone", () => {
	it("names the process type, and the utility process when there is one", () => {
		expect(describeChildProcessGone({ type: "GPU", reason: "crashed", exitCode: 5 })).toBe(
			"[app] the GPU process is gone (crashed, exit code 5)",
		);
		expect(
			describeChildProcessGone({
				type: "Utility",
				reason: "killed",
				exitCode: 9,
				name: "Audio Service",
			}),
		).toBe('[app] the Utility "Audio Service" process is gone (killed, exit code 9)');
	});
});
