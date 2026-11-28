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

		const unsubscribe = window.electronAPI.onKeystrokeKey((vk, modifiers) => {
			// The sampler captures the modifier state at the key's event time and sends
			// it with every keydown. An explicit mask -- including 0 -- is authoritative:
			// Ctrl down, Ctrl up, then C arrives with mask 0 and must read as "C", not a
			// stale "Ctrl+C". Only a stream that omits the mask (an older helper) falls
			// back to locally accumulated modifier presses.
			const current = new Set<number>();
			if (modifiers === undefined) {
				for (const modVk of heldModifiers.current) current.add(modVk);
			} else {
				for (const [bit, modVk] of MASK_TO_VK) {
					if (modifiers & bit) current.add(modVk);
				}
			}
			const isModifier = MODIFIER_KEYS.has(vk);
			if (isModifier) {
				// Track standalone modifier presses for the no-mask fallback only.
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
		<div className="w-screen h-screen bg-transparent flex items-start justify-center pt-16 pointer-events-none select-none">
			{/* Top-centre: the HUD bar and its popovers own the bottom of the display.
			    Badges used to sit at pb-16 and covered the cursor-mode and record
			    buttons in the recorded frames. */}
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
