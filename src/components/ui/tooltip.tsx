import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import * as React from "react";

import { cn } from "@/lib/utils";

// Timing from technical-documentation/engineering/tooltips.md: a tooltip appears 400 ms after
// the pointer stops, and moving to a neighbouring control within 300 ms shows its tooltip at once.
const TOOLTIP_OPEN_DELAY_MS = 400;
const TOOLTIP_SKIP_DELAY_MS = 300;
// The space between the trigger and the tooltip. 6px read as touching on a dark surface: a
// tooltip is dark too, so it needs a gap the eye can see.
export const TOOLTIP_GAP_PX = 8;

function TooltipProvider({
	delayDuration = TOOLTIP_OPEN_DELAY_MS,
	skipDelayDuration = TOOLTIP_SKIP_DELAY_MS,
	...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
	return (
		<TooltipPrimitive.Provider
			data-slot="tooltip-provider"
			delayDuration={delayDuration}
			skipDelayDuration={skipDelayDuration}
			{...props}
		/>
	);
}

function TooltipRoot({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Root>) {
	return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

// forwardRef, like PopoverTrigger: `Tooltip` below hands its own ref here, and on React 18
// a plain function component drops it silently — the ref resolves to null and React logs
// "Function components cannot be given refs".
const TooltipTrigger = React.forwardRef<
	React.ComponentRef<typeof TooltipPrimitive.Trigger>,
	React.ComponentProps<typeof TooltipPrimitive.Trigger>
>(({ onFocus, ...props }, ref) => (
	<TooltipPrimitive.Trigger
		ref={ref}
		data-slot="tooltip-trigger"
		onFocus={(event) => {
			onFocus?.(event);
			// Radix opens on every focus, and focus also comes back to a control the mouse clicked:
			// the window is switched back to, a dialog returns it to its opener. That tooltip stayed
			// open until the next blur, over the controls beside it. Only the keyboard's focus opens
			// it, the one `:focus-visible` marks (Radix skips a prevented event).
			if (!event.currentTarget.matches(":focus-visible")) event.preventDefault();
		}}
		{...props}
	/>
));
TooltipTrigger.displayName = "TooltipTrigger";

function TooltipContent({
	className,
	sideOffset = TOOLTIP_GAP_PX,
	...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
	return (
		<TooltipPrimitive.Portal>
			<TooltipPrimitive.Content
				data-slot="tooltip-content"
				// Follows the text's own direction, so Arabic starts at its own edge.
				dir="auto"
				sideOffset={sideOffset}
				className={cn(
					// Popper sizes its wrapper to `max-content`, so without a cap a long tooltip is one
					// long line. 260px is about 40 characters a line at this size. `text-balance` evens the
					// lines out, so a translation does not end on one orphan word.
					"max-w-[260px] break-words text-balance px-2.5 py-1.5 text-xs leading-4 font-medium text-white/95 bg-black/85 border border-white/10 rounded-lg shadow-lg z-50",
					"animate-in fade-in-0 zoom-in-95",
					"data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
					className,
				)}
				{...props}
			/>
		</TooltipPrimitive.Portal>
	);
}

// forwardRef for the same reason as PopoverTrigger above: this is a convenience
// wrapper people nest inside other `asChild` triggers, and on React 18 a plain
// function component silently drops the ref it is handed.
const Tooltip = React.forwardRef<
	React.ComponentRef<typeof TooltipTrigger>,
	{
		children: React.ReactNode;
		content: React.ReactNode;
		/**
		 * The current key binding, already formatted (`formatBinding`). Shown as a chip after the
		 * text, never inside the translated string: a remapped key would make that string lie, and
		 * a Latin key inside Arabic text breaks the order of the words.
		 */
		shortcut?: string;
		side?: "top" | "right" | "bottom" | "left";
		/**
		 * The distance from the trigger. Only for a trigger that is not the edge of what the eye
		 * sees, such as a button padded inside a bar: the tooltip then has to clear the bar.
		 */
		sideOffset?: number;
		/** Keeps the tooltip this far from the viewport's edges. */
		collisionPadding?: number;
		className?: string;
		/** Controlled, for a caller that must measure something at the moment the tooltip opens. */
		open?: boolean;
		onOpenChange?: (open: boolean) => void;
	}
>(
	(
		{
			children,
			content,
			shortcut,
			side,
			sideOffset,
			collisionPadding,
			className,
			open,
			onOpenChange,
		},
		ref,
	) => (
		<TooltipRoot open={open} onOpenChange={onOpenChange}>
			<TooltipTrigger ref={ref} asChild>
				{children}
			</TooltipTrigger>
			<TooltipContent
				side={side}
				sideOffset={sideOffset}
				collisionPadding={collisionPadding}
				className={className}
			>
				{content}
				{shortcut ? (
					<kbd
						dir="ltr"
						className="ms-2 inline-block rounded border border-white/15 bg-white/10 px-1 font-sans text-[11px] leading-4 text-white/80"
					>
						{shortcut}
					</kbd>
				) : null}
			</TooltipContent>
		</TooltipRoot>
	),
);
Tooltip.displayName = "Tooltip";

export { Tooltip, TooltipContent, TooltipProvider, TooltipRoot, TooltipTrigger };
