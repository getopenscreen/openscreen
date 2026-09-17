import assert from "node:assert/strict";
import { test } from "node:test";

import { isEnglishOnlyPath } from "./locale-routes.ts";

test("the blog is English-only, with or without the trailing slash", () => {
	for (const path of ["/blog", "/blog/", "/blog/2026/09/09/an-export-benchmark-hard-to-fake/"]) {
		assert.equal(isEnglishOnlyPath(path), true, path);
	}
	assert.equal(isEnglishOnlyPath("/blog/2026/09/09/an-export-benchmark-hard-to-fake"), true);
});

test("query strings and hashes do not change the answer", () => {
	assert.equal(isEnglishOnlyPath("/blog/?ref=footer"), true);
	assert.equal(isEnglishOnlyPath("/blog#latest"), true);
	assert.equal(isEnglishOnlyPath("/docs/faq/#does-openscreen-work-offline"), false);
});

test("translated routes and look-alikes are not English-only", () => {
	for (const path of [
		"/",
		"/download/",
		"/docs/intro/",
		"/features/captions/",
		"/alternatives/screen-studio/",
		"/compare/openscreen-vs-cap",
		"/screen-recorder-linux/",
		"/blogroll/",
		"/fr/blog/",
	]) {
		assert.equal(isEnglishOnlyPath(path), false, path);
	}
});
