// What `openscreen mcp` tells the agent about a newer OpenScreen, for the user who only ever
// reaches OpenScreen through an agent and so never sees the app's update button.
//
// This process updates nothing. Its stdout is the protocol, its lifetime is the client's, and an
// installer would end it mid-session. It only looks the latest release up, at most every six
// hours, and says so in its instructions; the agent passes it on, and the user updates. The
// lookup runs in the background and is cached, so the handshake never waits on the network: the
// session that finds a release says nothing, the next one does.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checkLatestRelease, compareVersions } from "../update-checker";

const CACHE_FILE = "mcp-update-check.json";
export const RELEASE_LOOKUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

interface ReleaseLookup {
	latestVersion: string;
	checkedAt: number;
}

type FetchLatest = Parameters<typeof checkLatestRelease>[0]["fetchLatest"];

export function readReleaseLookup(userData: string): ReleaseLookup | null {
	try {
		const raw = JSON.parse(readFileSync(path.join(userData, CACHE_FILE), "utf8")) as unknown;
		const { latestVersion, checkedAt } = (raw ?? {}) as Partial<ReleaseLookup>;
		if (typeof latestVersion !== "string" || typeof checkedAt !== "number") return null;
		return { latestVersion, checkedAt };
	} catch {
		return null;
	}
}

/** The line for the instructions, or null when there is nothing newer to tell. */
export function updateNotice(currentVersion: string, lookup: ReleaseLookup | null): string | null {
	if (!lookup) return null;
	try {
		if (compareVersions(lookup.latestVersion, currentVersion) <= 0) return null;
	} catch {
		return null;
	}
	return `OpenScreen ${lookup.latestVersion} is available; this is ${currentVersion}. Tell the user once, when it fits, that they can install it by opening the OpenScreen app. Never update OpenScreen yourself.`;
}

/** Looks the latest release up if the cached answer is older than the interval. Throws on a
 *  network or GitHub failure; the caller drops it, as the next session tries again. */
export async function refreshReleaseLookup(options: {
	userData: string;
	currentVersion: string;
	fetchLatest: FetchLatest;
	now?: number;
}): Promise<void> {
	const now = options.now ?? Date.now();
	const cached = readReleaseLookup(options.userData);
	if (cached && now - cached.checkedAt < RELEASE_LOOKUP_INTERVAL_MS) return;
	const result = await checkLatestRelease({
		currentVersion: options.currentVersion,
		fetchLatest: options.fetchLatest,
		signal: AbortSignal.timeout(10_000),
	});
	const lookup: ReleaseLookup = { latestVersion: result.latestVersion, checkedAt: now };
	writeFileSync(path.join(options.userData, CACHE_FILE), `${JSON.stringify(lookup)}\n`, "utf8");
}
