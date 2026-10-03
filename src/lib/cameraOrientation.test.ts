import { describe, expect, it } from "vitest";
import {
	isDeskView,
	normalizeCameraMirror,
	normalizeCameraRotation,
	resolveCameraOrientation,
	showsDeskLabel,
} from "./cameraOrientation";

describe("normalizeCameraRotation", () => {
	it("keeps 0 and 180", () => {
		expect(normalizeCameraRotation(0)).toBe(0);
		expect(normalizeCameraRotation(180)).toBe(180);
	});
	it("reads anything else as 0, so a newer project opens unrotated", () => {
		for (const v of [90, 270, -180, "180", null, undefined, Number.NaN]) {
			expect(normalizeCameraRotation(v)).toBe(0);
		}
	});
});

describe("normalizeCameraMirror", () => {
	it("keeps the three modes and reads anything else as auto", () => {
		expect(normalizeCameraMirror("on")).toBe("on");
		expect(normalizeCameraMirror("off")).toBe("off");
		expect(normalizeCameraMirror("auto")).toBe("auto");
		expect(normalizeCameraMirror(true)).toBe("auto");
		expect(normalizeCameraMirror(undefined)).toBe("auto");
	});
});

describe("resolveCameraOrientation", () => {
	it("is the project's mirror and no rotation outside a section", () => {
		expect(resolveCameraOrientation(null, true)).toEqual({
			rotation: 0,
			mirror: true,
			fullFrame: false,
		});
	});
	it("leaves a plain Full Camera section as the project has it", () => {
		expect(resolveCameraOrientation({}, true)).toEqual({
			rotation: 0,
			mirror: true,
			fullFrame: false,
		});
	});
	it("resolves auto to off when turned, even with the project mirror on", () => {
		expect(resolveCameraOrientation({ rotation: 180 }, true)).toEqual({
			rotation: 180,
			mirror: false,
			fullFrame: true,
		});
	});
	it("honours an explicit mirror on a turned section", () => {
		expect(resolveCameraOrientation({ rotation: 180, mirror: "on" }, false).mirror).toBe(true);
		expect(resolveCameraOrientation({ rotation: 0, mirror: "off" }, true).mirror).toBe(false);
	});
	it("treats an unknown rotation as none", () => {
		expect(resolveCameraOrientation({ rotation: 90 }, false)).toEqual({
			rotation: 0,
			mirror: false,
			fullFrame: false,
		});
	});
});

describe("isDeskView", () => {
	it("is rotation 180 with mirror auto", () => {
		expect(isDeskView({ rotation: 180 })).toBe(true);
		expect(isDeskView({ rotation: 180, mirror: "auto" })).toBe(true);
		expect(isDeskView({ rotation: 180, mirror: "on" })).toBe(false);
		expect(isDeskView({})).toBe(false);
	});
});

describe("showsDeskLabel", () => {
	it("shows unless explicitly false", () => {
		expect(showsDeskLabel({})).toBe(true);
		expect(showsDeskLabel({ deskLabel: false })).toBe(false);
		expect(showsDeskLabel({ deskLabel: "no" })).toBe(true);
	});
});
