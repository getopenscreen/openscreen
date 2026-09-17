// Dev only: every worktree serves its own Vite on localhost:5173 into the same userData
// profile, so the HTTP cache replays another server's response (seen: HTML for
// /src/styles/fonts.css). The module graph dies, the HUD never paints and shows as a black
// rectangle. Nothing on a dev server is worth caching.
export function disableHttpCacheForDevServer(
	commandLine: { appendSwitch(name: string): void },
	env: Record<string, string | undefined>,
): void {
	if (env["VITE_DEV_SERVER_URL"]) {
		commandLine.appendSwitch("disable-http-cache");
	}
}
