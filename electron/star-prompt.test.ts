import { describe, expect, it } from "vitest";
import {
	MS_STORE_PRODUCT_ID,
	offersStarPrompt,
	STAR_PROMPT_AT_EXPORT,
	type StarPromptState,
	storeReviewUrl,
} from "./star-prompt";

const state = (patch: Partial<StarPromptState> = {}): StarPromptState => ({
	successfulExports: STAR_PROMPT_AT_EXPORT,
	dismissed: false,
	recording: false,
	headless: false,
	...patch,
});

describe("star prompt policy", () => {
	it("offers on the second successful export and on no other", () => {
		expect(offersStarPrompt(state({ successfulExports: 1 }))).toBe(false);
		expect(offersStarPrompt(state({ successfulExports: 2 }))).toBe(true);
		expect(offersStarPrompt(state({ successfulExports: 3 }))).toBe(false);
		expect(offersStarPrompt(state({ successfulExports: 50 }))).toBe(false);
	});

	it("never asks again once the user has answered, either way", () => {
		expect(offersStarPrompt(state({ dismissed: true }))).toBe(false);
	});

	it("stays out of the way during a recording", () => {
		expect(offersStarPrompt(state({ recording: true }))).toBe(false);
	});

	it("never fires on a CLI or headless export", () => {
		expect(offersStarPrompt(state({ headless: true }))).toBe(false);
	});

	it("keeps every veto independent of the export count", () => {
		// A veto that only held at the offer count would let the prompt through the moment the
		// count moved past it, which is exactly when a regression would go unnoticed.
		for (const count of [1, 2, 3]) {
			expect(offersStarPrompt(state({ successfulExports: count, dismissed: true }))).toBe(false);
			expect(offersStarPrompt(state({ successfulExports: count, recording: true }))).toBe(false);
			expect(offersStarPrompt(state({ successfulExports: count, headless: true }))).toBe(false);
		}
	});

	it("builds the Store review deep link from the shipped product id", () => {
		// Same id as the website's Store link and the winget command; a typo here sends the user
		// to a Store page that does not exist, and nothing else in the app would notice.
		expect(MS_STORE_PRODUCT_ID).toBe("9MXQ1HQJL5G5");
		expect(storeReviewUrl()).toBe("ms-windows-store://review/?ProductId=9MXQ1HQJL5G5");
	});
});
