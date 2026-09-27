import type { CSSProperties } from "react";
import { Toaster as Sonner } from "sonner";
import { useScopedT } from "@/contexts/I18nContext";
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
	const tc = useScopedT("common");
	return (
		<Sonner
			className={cn(
				"toaster group pointer-events-none [&_[data-sonner-toast]]:pointer-events-auto",
				className,
			)}
			style={{ ...TOKEN_STYLE, ...style }}
			duration={3000}
			// A toast that can only be waited out is the one case where the 3s timer works
			// against the reader: an error with a long description is dismissed before it is
			// finished, and a stack of them hides the editor with no way to clear it. The
			// cross is placed on the END side by `src/index.css` — sonner puts it on the
			// start side, which is not where anything else in this app closes. Its colours live
			// there too: from `classNames` they lose to sonner's own rule.
			closeButton
			toastOptions={{
				// Sonner's default is the untranslated "Close toast"; the rest of the app
				// speaks 13 languages.
				closeButtonAriaLabel: tc("actions.closeNotification"),
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
