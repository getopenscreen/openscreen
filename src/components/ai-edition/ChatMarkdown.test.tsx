// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatMarkdown } from "./ChatMarkdown";

afterEach(cleanup);
it("renders common Markdown and GFM tables without changing code indentation", () => {
	const { container } = render(
		<ChatMarkdown
			text={
				"# Heading\n\n**Bold** and *emphasis*\n\n- Item\n\n> Quote\n\n```ts\n  const x = 1;\n```\n\n| A | B |\n| - | - |\n| 1 | 2 |"
			}
		/>,
	);
	expect(screen.getByRole("heading")).toHaveTextContent("Heading");
	expect(container.querySelector("strong")).toHaveTextContent("Bold");
	expect(screen.getByRole("listitem")).toHaveTextContent("Item");
	expect(screen.getByRole("table")).toHaveTextContent("A");
	expect(container.querySelector("pre code")?.textContent).toBe("  const x = 1;\n");
});
it("rejects scripts, raw HTML, dangerous links, local navigation and remote images", () => {
	const { container } = render(
		<ChatMarkdown
			text={
				"<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[bad](javascript:alert%281%29) [local](file:///etc/passwd) [relative](../secret) ![hidden](https://tracker.invalid/pixel)"
			}
		/>,
	);
	expect(container.querySelector("script, img, iframe")).toBeNull();
	expect(container.querySelector("a")).toBeNull();
});
it("opens an explicit safe link through the desktop URL handler", () => {
	const openExternalUrl = vi.fn().mockResolvedValue({ success: true });
	window.electronAPI = { openExternalUrl } as unknown as typeof window.electronAPI;
	render(<ChatMarkdown text="[Project](https://getopenscreen.com/)" />);
	fireEvent.click(screen.getByRole("link", { name: "Project" }));
	expect(openExternalUrl).toHaveBeenCalledWith("https://getopenscreen.com/");
});
