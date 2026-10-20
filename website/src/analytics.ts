import { downloadClick } from "./lib/download-target";

// A project token is public by design: it can only send events, not read them.
const POSTHOG_TOKEN = "phc_zhJDJHBBRDAJBwSb7zf2JuQ59v6RwBN96ZksM2y4oq8C";

// The live domain only, so neither `npm run dev`, a local `serve` nor a preview
// deployment counts. posthog-js is fetched as its own chunk, after hydration has
// started, so it never holds up the first paint.
if (typeof window !== "undefined" && window.location.hostname === "getopenscreen.com") {
	void import("posthog-js").then(({ default: posthog }) => {
		posthog.init(POSTHOG_TOKEN, {
			api_host: "https://eu.i.posthog.com",
			defaults: "2026-08-30",
			// Nothing stored in the browser, so no consent banner. PostHog counts
			// visitors with a daily hash it computes server-side, which needs
			// "Cookieless server hash mode" on in the project settings.
			cookieless_mode: "always",
			person_profiles: "never",
			// The privacy policy (/privacy/) says sessions are not recorded: keep it
			// true in code, whatever the project's remote settings say.
			disable_session_recording: true,
		});
		// One listener for every download link on the site: the landing page's
		// button, /download/'s cards and any page that links a release asset.
		document.addEventListener("click", (event) => {
			const link = event.target instanceof Element ? event.target.closest("a") : null;
			const download = link ? downloadClick(link.href) : null;
			// sendBeacon survives the navigation a Store or fallback link starts.
			if (download) posthog.capture("download_clicked", download, { transport: "sendBeacon" });
		});
	});
}
