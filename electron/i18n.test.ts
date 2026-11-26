import { afterEach, expect, it } from "vitest";
import commonFa from "../src/i18n/locales/fa/common.json";
import dialogsFa from "../src/i18n/locales/fa/dialogs.json";
import { getMainLocale, mainT, setMainLocale } from "./i18n";

afterEach(() => {
	setMainLocale("en");
});

it("uses Persian messages for native menus and dialogs", () => {
	setMainLocale("fa");

	expect(getMainLocale()).toBe("fa");
	expect(mainT("common", "actions.recordingStatus", { source: "Safari" })).toBe(
		commonFa.actions.recordingStatus.replace("{{source}}", "Safari"),
	);
	expect(mainT("dialogs", "unsavedChanges.title")).toBe(dialogsFa.unsavedChanges.title);
});
