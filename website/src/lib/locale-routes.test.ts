import assert from "node:assert/strict";
import { test } from "node:test";

import { BLOG_PATH, ENGLISH_ONLY_PAGES, isEnglishOnlyPath } from "./locale-routes.ts";

test("every English-only family matches, with and without the trailing slash", () => {
	for (const prefix of [BLOG_PATH, ...ENGLISH_ONLY_PAGES.map((page) => page.path)]) {
		const page = prefix.endsWith("/") ? `${prefix}some-page/` : `${prefix}linux/`;
		assert.equal(isEnglishOnlyPath(page), true, page);
		assert.equal(isEnglishOnlyPath(page.slice(0, -1)), true, page.slice(0, -1));
	}
	// The family roots themselves, as the navbar and footer write them.
	assert.equal(isEnglishOnlyPath("/blog"), true);
	assert.equal(isEnglishOnlyPath("/blog/"), true);
});

test("query strings and hashes do not change the answer", () => {
	assert.equal(isEnglishOnlyPath("/features/captions/#offline"), true);
	assert.equal(isEnglishOnlyPath("/compare/openscreen-vs-cap?ref=docs"), true);
	assert.equal(isEnglishOnlyPath("/docs/faq/#does-openscreen-work-offline"), false);
});

test("translated routes and look-alikes are not English-only", () => {
	for (const path of [
		"/",
		"/download/",
		"/docs/intro/",
		"/docs/captions/",
		"/blogroll/",
		"/featured/",
		"/screen-recorder",
		"/fr/blog/",
		"/fr/features/captions/",
	]) {
		assert.equal(isEnglishOnlyPath(path), false, path);
	}
});
