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

// jsdom does not cascade, so it cannot show which rule wins. What it can pin is where the
// colours live: sonner's dark theme sets the button's colour at (0,4,0), so a colour passed
// as a Tailwind utility through `classNames` (0,3,0) silently never applies, and the one
// place that does apply is the `html`-prefixed override in src/index.css.
describe("close button colours", () => {
	const root = path.resolve(__dirname, "..", "..", "..");
	const appCss = readFileSync(path.join(root, "src/index.css"), "utf8");
	const closeRule = (suffix: string) => {
		const selector = `html [data-sonner-toaster] [data-sonner-toast][data-styled="true"] [data-close-button]${suffix} {`;
		const start = appCss.indexOf(selector);
		expect(start, selector).toBeGreaterThanOrEqual(0);
		return appCss.slice(start, appCss.indexOf("}", start));
	};

	it("sets the resting and hover colour in the override that outranks sonner", () => {
		expect(closeRule("")).toMatch(/^\s*color:/m);
		expect(closeRule(":hover")).toMatch(/^\s*color:/m);
	});

	// Sonner's dark `:hover` rule outranks the base override and restores its border, so the
	// "no border" decision has to be repeated on hover or a ring appears under the pointer.
	it("keeps the border off on hover as well as at rest", () => {
		expect(closeRule("")).toMatch(/border-color:\s*transparent/);
		expect(closeRule(":hover")).toMatch(/border-color:\s*transparent/);
	});

	it("does not pass them through classNames, where they lose", () => {
		const toaster = readFileSync(path.join(root, "src/components/ui/sonner.tsx"), "utf8");
		expect(toaster).not.toMatch(/closeButton:\s*"/);
	});
});
