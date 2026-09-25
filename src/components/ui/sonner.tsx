import type { CSSProperties } from "react";
import { Toaster as Sonner } from "sonner";
import { cn } from "@/lib/utils";

type ToasterProps = React.ComponentProps<typeof Sonner>;

// Sonner paints a toast from its own variables, under `[data-styled=true]` selectors that
// outrank any class passed in `toastOptions` — which is why the old `bg-[#09090b]` never
// showed and every toast came out #000, 8px, in the system font. Setting the variables on
// the toaster itself is the documented override. They are design tokens, so the toasts
// follow the app theme (index.html sets `data-theme` in every window) without a `theme` prop.
const TOKEN_STYLE = {
	"--normal-bg": "var(--surface-hi)",
	"--normal-border": "var(--border-hi)",
	"--normal-text": "var(--fg)",
	"--border-radius": "12px",
	fontFamily: "var(--font-body)",
} as CSSProperties;

const Toaster = ({ className, style, ...props }: ToasterProps) => {
	return (
		<Sonner
			className={cn(
				"toaster group pointer-events-none [&_[data-sonner-toast]]:pointer-events-auto",
				className,
			)}
			style={{ ...TOKEN_STYLE, ...style }}
			duration={3000}
			toastOptions={{
				style: { boxShadow: "var(--elev-pop)" },
				classNames: {
					// `!`: sonner colours the description per its own theme, above any plain class.
					description: "!text-[var(--muted)]",
					actionButton:
						"!h-7 !rounded-[8px] !bg-[var(--accent)] !px-2.5 !text-[13px] !text-[var(--accent-on)]",
					cancelButton:
						"!h-7 !rounded-[8px] !bg-[var(--surface-3)] !px-2.5 !text-[13px] !text-[var(--fg)]",
				},
			}}
			{...props}
		/>
	);
};

export { Toaster };
