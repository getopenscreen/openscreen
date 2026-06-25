import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.tsx";
import { I18nProvider } from "./contexts/I18nContext";
import "./index.css";

// === One-shot uncaught trap — capture stack traces for the .geometry null deref in #8.
// Delete after the diagnostic run that closes out the issue's root cause.
const __errTrap = (tag: string) => (e: ErrorEvent | PromiseRejectionEvent) => {
	const isRej = "reason" in e;
	const err = isRej ? (e as PromiseRejectionEvent).reason : (e as ErrorEvent).error;
	const evt = e as ErrorEvent;
	console.error(
		`[VideoEditor] ${tag}`,
		JSON.stringify({
			message: err?.message ?? String(err),
			source: isRej ? null : evt.filename,
			lineno: isRej ? null : evt.lineno,
			colno: isRej ? null : evt.colno,
			stack: err?.stack ?? null,
		}),
	);
};
window.addEventListener("error", __errTrap("uncaught"));
window.addEventListener("unhandledrejection", __errTrap("unhandledrejection"));
// === end trap ===

const windowType = new URLSearchParams(window.location.search).get("windowType") || "";
if (
	windowType === "hud-overlay" ||
	windowType === "source-selector" ||
	windowType === "countdown-overlay"
) {
	document.body.style.background = "transparent";
	document.documentElement.style.background = "transparent";
	document.getElementById("root")?.style.setProperty("background", "transparent");
}

ReactDOM.createRoot(document.getElementById("root")!).render(
	<React.StrictMode>
		<I18nProvider>
			<App />
		</I18nProvider>
	</React.StrictMode>,
);
