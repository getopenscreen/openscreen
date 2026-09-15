// @vitest-environment jsdom
// A toast used to be dismissable only by waiting. That is fine for a confirmation and
// wrong for an error: the 3s timer can retire a long description before it has been read,
// and a run of failures stacks up over the editor with nothing to clear it.
//
// The placement itself (top END corner, mirrored for RTL) is CSS custom properties in
// src/index.css, which jsdom does not apply — what is pinned here is that the button
// exists at all and that it speaks the app's language rather than sonner's hardcoded
// "Close toast".
import "@testing-library/jest-dom";
import { readFileSync } from "node:fs";
import path from "node:path";
import { render, screen } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { Toaster } from "./sonner";

afterEach(() => {
	toast.dismiss();
});

describe("Toaster", () => {
	it("gives every toast a close button", async () => {
		render(
			<I18nProvider>
				<Toaster />
			</I18nProvider>,
		);
		toast("Export finished");
		expect(await screen.findByText("Export finished")).toBeInTheDocument();
		expect(await screen.findByRole("button", { name: /close notification/i })).toBeInTheDocument();
	});

	// Sonner's default label is the untranslated "Close toast", and a screen reader in any
	// of the other twelve locales would hear it.
	it("labels it from the app's own strings, not sonner's default", async () => {
		render(
			<I18nProvider>
				<Toaster />
			</I18nProvider>,
		);
		toast.error("Could not export");
		const close = await screen.findByRole("button", { name: /close notification/i });
		expect(close).toHaveAttribute("data-close-button", "true");
		expect(screen.queryByRole("button", { name: /close toast/i })).not.toBeInTheDocument();
	});
});

// The placement is three CSS custom properties that sonner owns. jsdom cannot tell us
// where the button lands, but it can tell us the contract still exists — and that is the
// failure mode that matters: on a sonner upgrade that renames them, the override quietly
// stops applying and the cross goes back to the top LEFT with every test still green.
describe("close button placement contract", () => {
	const root = path.resolve(__dirname, "..", "..", "..");
	const sonnerCss = readFileSync(path.join(root, "node_modules/sonner/dist/styles.css"), "utf8");
	const appCss = readFileSync(path.join(root, "src/index.css"), "utf8");

	for (const variable of [
		"--toast-close-button-start",
		"--toast-close-button-end",
		"--toast-close-button-transform",
	]) {
		it(`sonner still positions the close button with ${variable}`, () => {
			expect(sonnerCss).toContain(variable);
			expect(appCss).toContain(variable);
		});
	}

	// Both directions, because the override exists to MOVE the button, and doing that in
	// one direction only would leave ar mirrored the wrong way once the app sets `dir`.
	for (const dir of ["ltr", "rtl"]) {
		it(`overrides it for dir="${dir}"`, () => {
			expect(appCss).toContain(`[data-sonner-toaster][dir="${dir}"]`);
		});
	}
});
