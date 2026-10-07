import type { KeyboardEvent } from "react";

/**
 * ArrowUp/ArrowDown between the items of the menu the handler sits on, wrapping both ways.
 * Enter and Space need nothing: the items are buttons. Escape stays with each menu, which
 * knows where focus goes back to.
 */
export function moveMenuFocus(e: KeyboardEvent<HTMLElement>) {
	if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
	e.preventDefault();
	const items = Array.from(
		e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]'),
	);
	if (items.length === 0) return;
	const at = items.indexOf(document.activeElement as HTMLElement);
	const next = e.key === "ArrowDown" ? at + 1 : at - 1;
	// `at` is -1 when focus escaped the list, and ArrowDown then lands on 0.
	items[(next + items.length) % items.length]?.focus();
}
