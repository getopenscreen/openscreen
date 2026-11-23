import { describe, expect, it } from "vitest";
import {
	consumeXevButtonEvents,
	consumeXInputXi2Events,
	interactionTypeForButton,
	parseLibinputButtonLine,
} from "./x11PointerParse";

describe("consumeXInputXi2Events", () => {
	const press = `EVENT type 15 (RawButtonPress)
    device: 12 (12)
    detail: 1
    flags:
    root: 10.00/20.00
`;
	const release = `EVENT type 16 (RawButtonRelease)
    device: 12 (12)
    detail: 1
    flags:
`;

	it("extracts a complete press and leaves a partial block", () => {
		const parsed = consumeXInputXi2Events(`${press}EVENT type 15 (RawButtonPress)\n    device: 1`);
		expect(parsed.events).toEqual([{ kind: "press", button: 1 }]);
		expect(parsed.rest).toContain("EVENT type 15 (RawButtonPress)");
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
			`${motion}${press}${motion}EVENT type 15 (RawButtonPress)\n    device: 12\n`,
		);
		expect(parsed.events).toEqual([{ kind: "press", button: 1 }]);
		expect(parsed.rest).toBe("EVENT type 15 (RawButtonPress)\n    device: 12\n");
		expect(parsed.rest).not.toContain("RawMotion");
	});
	it("ignores normal button events so a root click is not counted twice", () => {
		const normal = press.replace("15 (RawButtonPress)", "4 (ButtonPress)");
		expect(consumeXInputXi2Events(normal + press).events).toEqual([{ kind: "press", button: 1 }]);
	});
	it("retains a detail number split across chunks", () => {
		const partial = "EVENT type 15 (RawButtonPress)\n    device: 2 (12)\n    detail: 1";
		const parsed = consumeXInputXi2Events(partial);
		expect(parsed.events).toEqual([]);
		expect(consumeXInputXi2Events(parsed.rest + "2\n").events).toEqual([
			{ kind: "press", button: 12 },
		]);
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

// Every possible transport boundary, including a partial header after an emitted event.
describe("button parser transport boundaries", () => {
	const cases = [
		{
			name: "XI2",
			consume: consumeXInputXi2Events,
			press: "EVENT type 15 (RawButtonPress)\n detail: 1\n flags:\n",
			release: "EVENT type 16 (RawButtonRelease)\n detail: 1\n",
		},
		{
			name: "xev",
			consume: consumeXevButtonEvents,
			press: "ButtonPress event, serial 1,\n button 1, same_screen YES\n",
			release: "ButtonRelease event, serial 2,\n button 1, same_screen YES\n",
		},
	];
	for (const { name, consume, press, release } of cases) {
		it(`${name} preserves the next event at every two-chunk boundary`, () => {
			const text = press + release;
			for (let split = 1; split < text.length; split++) {
				const first = consume(text.slice(0, split));
				const second = consume(first.rest + text.slice(split));
				expect([...first.events, ...second.events], `split=${split}`).toEqual([
					{ kind: "press", button: 1 },
					{ kind: "release", button: 1 },
				]);
				expect(consume(second.rest).events).toEqual([]);
			}
		});
		it(`${name} handles one-byte chunks without duplicates or false button 1`, () => {
			let rest = "";
			const events = [];
			for (const byte of (press + release)
				.replace(/button 1,/g, "button 12,")
				.replace(/detail: 1\n/g, "detail: 12\n")) {
				const parsed = consume(rest + byte);
				rest = parsed.rest;
				events.push(...parsed.events);
			}
			expect(events).toEqual([
				{ kind: "press", button: 12 },
				{ kind: "release", button: 12 },
			]);
			expect(events.map((e) => interactionTypeForButton(e.kind, e.button))).toEqual([null, null]);
		});
	}
	it("xev waits for a numeric delimiter", () => {
		const first = consumeXevButtonEvents("ButtonPress event, serial 1,\n button 1");
		expect(first.events).toEqual([]);
		expect(consumeXevButtonEvents(first.rest + "2, same_screen YES\n").events).toEqual([
			{ kind: "press", button: 12 },
		]);
	});
});

describe("xev tail bounds", () => {
	it("drops headerless event tails on repeated split chunks", () => {
		let rest = "";
		let count = 0;
		for (let i = 0; i < 100; i++) {
			for (const chunk of ["ButtonPress event, serial 1,\n button 1,", " same_screen YES\n"]) {
				const parsed = consumeXevButtonEvents(rest + chunk);
				rest = parsed.rest;
				count += parsed.events.length;
				expect(rest.length).toBeLessThan(32);
			}
		}
		expect(count).toBe(100);
	});
});
