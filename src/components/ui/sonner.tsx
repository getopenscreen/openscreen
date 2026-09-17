import { Toaster as Sonner } from "sonner";
import { useScopedT } from "@/contexts/I18nContext";
import { cn } from "@/lib/utils";

type ToasterProps = React.ComponentProps<typeof Sonner>;

const Toaster = ({ className, ...props }: ToasterProps) => {
	const tc = useScopedT("common");
	return (
		<Sonner
			theme="dark"
			className={cn(
				"dark toaster group pointer-events-none [&_[data-sonner-toast]]:pointer-events-auto",
				className,
			)}
			duration={3000}
			// A toast that can only be waited out is the one case where the 3s timer works
			// against the reader: an error with a long description is dismissed before it is
			// finished, and a stack of them hides the editor with no way to clear it. The
			// cross is placed on the END side and coloured by `src/index.css`: sonner puts it
			// on the start side, which is not where anything else in this app closes, and
			// its dark theme outranks any colour utility passed through `classNames`.
			closeButton
			toastOptions={{
				// Sonner's default is the untranslated "Close toast"; the rest of the app
				// speaks 13 languages.
				closeButtonAriaLabel: tc("actions.closeNotification"),
				classNames: {
					toast:
						"group toast border border-white/10 bg-[#09090b] text-slate-200 shadow-lg backdrop-blur-xl",
					description: "group-[.toast]:text-slate-400",
					actionButton: "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
					cancelButton: "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
				},
			}}
			{...props}
		/>
	);
};

export { Toaster };
