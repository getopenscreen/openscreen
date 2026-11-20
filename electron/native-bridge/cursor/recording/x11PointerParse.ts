export type ParsedButtonEvent = {
	kind: "press" | "release";
	button: number;
};

// A parsed block can end with the first bytes of the NEXT header. Keep that
// suffix, but not the parsed header (which would emit the same event twice).
function trailingHeaderPrefix(text: string, headers: string[]): string {
	for (
		let length = Math.min(text.length, Math.max(...headers.map((h) => h.length)));
		length > 0;
		length--
	) {
		const suffix = text.slice(-length);
		if (headers.some((header) => header.startsWith(suffix))) return suffix;
	}
	return "";
}

/**
 * Pulls complete XI2 raw button events out of a growing stdout buffer.
 *
 * `xinput test-xi2 --root` prints a multi-line block per event. `detail` is the
 * button number (1 = left). Incomplete trailing text is returned as the leftover.
 */
export function consumeXInputXi2Events(buffer: string): {
	events: ParsedButtonEvent[];
	rest: string;
} {
	const events: ParsedButtonEvent[] = [];
	const blocks = buffer.split(/(?=EVENT type )/);
	let rest = "";
	for (const [index, block] of blocks.entries()) {
		const isLast = index === blocks.length - 1;
		if (!block.trim()) {
			continue;
		}
		// Raw events reach the root even when a focused application consumes the
		// normal button event. Ignore normal events to avoid recording root clicks twice.
		const header = block.match(/EVENT type\s+(\d+)\s+\((RawButtonPress|RawButtonRelease)\)/i);
		if (!header) {
			// Complete non-button blocks (motion, hierarchy, …) must not accumulate
			// for the whole recording. Keep only a trailing block, which may still
			// be incomplete.
			if (isLast) {
				rest += block;
			}
			continue;
		}
		const detail = block.match(/\bdetail:[ \t]*(\d+)[ \t]*\r?\n/);
		if (!detail) {
			if (isLast) {
				rest += block;
			}
			continue;
		}
		events.push({
			kind: header[2].toLowerCase() === "rawbuttonpress" ? "press" : "release",
			button: Number(detail[1]),
		});
		if (isLast)
			rest += trailingHeaderPrefix(block.slice(detail.index! + detail[0].length), ["EVENT type "]);
	}
	return { events, rest };
}

/**
 * Pulls complete `xev -root -event button` events out of a growing stdout buffer.
 *
 * The comma after `button N` completes the number, even across stdout chunks.
 */
export function consumeXevButtonEvents(buffer: string): {
	events: ParsedButtonEvent[];
	rest: string;
} {
	const events: ParsedButtonEvent[] = [];
	const blocks = buffer.split(/(?=Button(?:Press|Release) event)/);
	let rest = "";
	for (const block of blocks) {
		if (!block.trim()) {
			continue;
		}
		const kindMatch = block.match(/Button(Press|Release) event/);
		const buttonMatch = block.match(/\bbutton[ \t]+(\d+),/);
		if (!kindMatch || !buttonMatch) {
			rest += block;
			continue;
		}
		events.push({
			kind: kindMatch[1] === "Press" ? "press" : "release",
			button: Number(buttonMatch[1]),
		});
		rest += trailingHeaderPrefix(block.slice(buttonMatch.index! + buttonMatch[0].length), [
			"ButtonPress event",
			"ButtonRelease event",
		]);
	}
	return { events, rest };
}

/**
 * One line of `libinput debug-events`. Only BTN_LEFT / BTN_RIGHT / BTN_MIDDLE
 * (or POINTER_BUTTON with a numeric code) become click events.
 */
export function parseLibinputButtonLine(line: string): ParsedButtonEvent | null {
	if (!/POINTER_BUTTON/.test(line)) {
		return null;
	}
	const kind = /\bpressed\b/.test(line) ? "press" : /\breleased\b/.test(line) ? "release" : null;
	if (!kind) {
		return null;
	}
	if (/\bBTN_LEFT\b/.test(line)) {
		return { kind, button: 1 };
	}
	if (/\bBTN_MIDDLE\b/.test(line)) {
		return { kind, button: 2 };
	}
	if (/\bBTN_RIGHT\b/.test(line)) {
		return { kind, button: 3 };
	}
	return null;
}

export function interactionTypeForButton(
	kind: "press" | "release",
	button: number,
): "click" | "right-click" | "middle-click" | "mouseup" | null {
	if (kind === "release") {
		return button === 1 || button === 2 || button === 3 ? "mouseup" : null;
	}
	if (button === 1) {
		return "click";
	}
	if (button === 2) {
		return "middle-click";
	}
	if (button === 3) {
		return "right-click";
	}
	return null;
}
