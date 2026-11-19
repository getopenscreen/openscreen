import { useEffect, useRef, useState } from "react";
import { badgeLabel, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT } from "@/lib/keystrokeLabels";

/** How long a badge stays up before it fades out (matched by the CSS animation). */
export const BADGE_VISIBLE_MS = 1_300;

interface KeystrokeBadge {
	id: number;
	label: string;
}

/** Modifier virtual keys, as a set the badge labels compose from. */
const MODIFIER_KEYS = new Set([VK_SHIFT, VK_CONTROL, VK_MENU, VK_LWIN, VK_RWIN]);

/** Modifier bit mask from the sampler: 1=Shift 2=Ctrl 4=Alt 8=Win. */
const MASK_TO_VK: readonly [number, number][] = [
	[1, VK_SHIFT],
	[2, VK_CONTROL],
	[4, VK_MENU],
	[8, VK_LWIN],
];

/**
 * The keystroke overlay: badges for the keys pressed while a take is live, bottom-centre
 * of the display being recorded. Keydowns arrive live from the Windows sampler's
 * WH_KEYBOARD_LL hook (`keystroke-overlay-key` via preload); nothing is shown when no
 * take is running, because the window itself only exists then.
 */
export function KeystrokeOverlay() {
	const [badges, setBadges] = useState<KeystrokeBadge[]>([]);
	const heldModifiers = useRef<Set<number>>(new Set());
	const nextBadgeId = useRef(1);

	useEffect(() => {
		const timers: ReturnType<typeof setTimeout>[] = [];

		const unsubscribe = window.electronAPI.onKeystrokeKey((vk, modifiers = 0) => {
			// The sampler captured the modifier state at the key's event time. Expand
			// it into the same VK set the labels compose from; the local accumulation
			// is a fallback for streams that omit modifiers (older helpers). Both are
			// unioned so a modifier press followed by a regular key reads as one combo.
			const current = new Set(heldModifiers.current);
			for (const [bit, modVk] of MASK_TO_VK) {
				if (modifiers & bit) current.add(modVk);
			}
			const isModifier = MODIFIER_KEYS.has(vk);
			if (isModifier) {
				// A standalone modifier still shows its own badge, and stays held for
				// the next non-modifier key (rather than being cleared).
				heldModifiers.current.add(vk);
				current.add(vk);
			}
			// Compose from the current set BEFORE a non-modifier releases it.
			const label = badgeLabel(vk, current);
			if (!isModifier) {
				heldModifiers.current.clear();
			}
			if (!label) return;

			const id = nextBadgeId.current++;
			setBadges((currentBadges) => [...currentBadges.slice(-4), { id, label }]);
			timers.push(
				setTimeout(() => {
					setBadges((currentBadges) => currentBadges.filter((badge) => badge.id !== id));
				}, BADGE_VISIBLE_MS),
			);
		});

		return () => {
			unsubscribe();
			for (const timer of timers) clearTimeout(timer);
			heldModifiers.current.clear();
		};
	}, []);

	if (badges.length === 0) {
		return null;
	}

	return (
		<div className="w-screen h-screen bg-transparent flex items-end justify-center pb-16 pointer-events-none select-none">
			<div className="flex items-center gap-2">
				{badges.map((badge) => (
					<div key={badge.id} className="keystroke-badge">
						{badge.label}
					</div>
				))}
			</div>
		</div>
	);
}
