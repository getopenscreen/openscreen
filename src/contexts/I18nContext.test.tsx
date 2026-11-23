// @vitest-environment jsdom
import { useDirection } from "@radix-ui/react-direction";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LOCALE_STORAGE_KEY } from "@/i18n/config";
import { getLocaleDirection } from "@/i18n/loader";
import { I18nProvider, useI18n } from "./I18nContext";

afterEach(() => {
	localStorage.clear();
	document.documentElement.removeAttribute("lang");
	document.documentElement.removeAttribute("dir");
});

describe("locale direction", () => {
	it.each(["ar", "ar-SA", "fa", "fa-IR"])("uses RTL for %s", (locale) => {
		expect(getLocaleDirection(locale)).toBe("rtl");
	});

	it("initializes from the saved locale and updates the document and controls on switch", () => {
		localStorage.setItem(LOCALE_STORAGE_KEY, "ar");
		const { result } = renderHook(() => ({ ...useI18n(), direction: useDirection() }), {
			wrapper: I18nProvider,
		});

		expect(document.documentElement.lang).toBe("ar");
		expect(document.documentElement.dir).toBe("rtl");
		expect(result.current.direction).toBe("rtl");

		act(() => result.current.setLocale("en"));

		expect(document.documentElement.lang).toBe("en");
		expect(document.documentElement.dir).toBe("ltr");
		expect(result.current.direction).toBe("ltr");
		expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("en");
	});
});
