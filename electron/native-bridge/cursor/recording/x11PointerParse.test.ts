import { describe, expect, it } from "vitest";
import {
	consumeXevButtonEvents,
	consumeXInputXi2Events,
	interactionTypeForButton,
	parseLibinputButtonLine,
	parseXdotoolLocation,
} from "./x11PointerParse";

describe("parseXdotoolLocation", () => {
	it("reads --shell output", () => {
		expect(parseXdotoolLocation("X=100\nY=200\nSCREEN=0\nWINDOW=12\n")).toEqual({
			x: 100,
			y: 200,
		});
	});

	it("reads the inline form", () => {
		expect(parseXdotoolLocation("x:12 y:34 screen:0 window:99")).toEqual({ x: 12, y: 34 });
	});

	it("returns null when the point is missing", () => {
		expect(parseXdotoolLocation("nothing here")).toBeNull();
	});
});

describe("consumeXInputXi2Events", () => {
	const press = `EVENT type 4 (ButtonPress)
    device: 12 (12)
    detail: 1
    flags:
    root: 10.00/20.00
`;
	const release = `EVENT type 5 (ButtonRelease)
    device: 12 (12)
    detail: 1
    flags:
`;

	it("extracts a complete press and leaves a partial block", () => {
		const parsed = consumeXInputXi2Events(`${press}EVENT type 4 (ButtonPress)\n    device: 1`);
		expect(parsed.events).toEqual([{ kind: "press", button: 1 }]);
		expect(parsed.rest).toContain("EVENT type 4 (ButtonPress)");
	});

	it("extracts press then release", () => {
		const parsed = consumeXInputXi2Events(press + release);
		expect(parsed.events).toEqual([
			{ kind: "press", button: 1 },
			{ kind: "release", button: 1 },
		]);
		expect(parsed.rest).toBe("");
	});

	it("drops complete non-button blocks and keeps only a trailing incomplete rest", () => {
		const motion = `EVENT type 17 (RawMotion)
    device: 12 (12)
    detail: 0
    flags:
`;
		const parsed = consumeXInputXi2Events(
			`${motion}${press}${motion}EVENT type 4 (ButtonPress)\n    device: 12\n`,
		);
		expect(parsed.events).toEqual([{ kind: "press", button: 1 }]);
		expect(parsed.rest).toBe("EVENT type 4 (ButtonPress)\n    device: 12\n");
		expect(parsed.rest).not.toContain("RawMotion");
	});
});

describe("consumeXevButtonEvents", () => {
	const block = `ButtonPress event, serial 32, synthetic NO, window 0x6a3,
    root 0x51e, subw 0x0, time 1847541, (88,54), root:(1009,873),
    state 0x0, button 1, same_screen YES
`;

	it("extracts button 1 press", () => {
		const parsed = consumeXevButtonEvents(block);
		expect(parsed.events).toEqual([{ kind: "press", button: 1 }]);
		expect(parsed.rest).toBe("");
	});

	it("holds an incomplete event", () => {
		const parsed = consumeXevButtonEvents("ButtonPress event, serial 1,\n    root 0x1\n");
		expect(parsed.events).toEqual([]);
		expect(parsed.rest).toContain("ButtonPress event");
	});
});

describe("parseLibinputButtonLine", () => {
	it("reads a left press", () => {
		expect(
			parseLibinputButtonLine(
				"event0  POINTER_BUTTON    +1.23s\tBTN_LEFT (272) pressed, seat count: 1",
			),
		).toEqual({ kind: "press", button: 1 });
	});

	it("ignores motion", () => {
		expect(parseLibinputButtonLine("event0  POINTER_MOTION +0.1s  1.0/2.0")).toBeNull();
	});
});

describe("interactionTypeForButton", () => {
	it("maps left/middle/right press and any release of those to mouseup", () => {
		expect(interactionTypeForButton("press", 1)).toBe("click");
		expect(interactionTypeForButton("press", 2)).toBe("middle-click");
		expect(interactionTypeForButton("press", 3)).toBe("right-click");
		expect(interactionTypeForButton("release", 1)).toBe("mouseup");
		expect(interactionTypeForButton("press", 8)).toBeNull();
	});
});
