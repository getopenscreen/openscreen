const RELEASES_API = "https://api.github.com/repos/getopenscreen/openscreen/releases";
const LATEST_RELEASE_API = `${RELEASES_API}/latest`;
// An RC also wants newer RCs, which `releases/latest` never returns.
const RECENT_RELEASES_API = `${RELEASES_API}?per_page=20`;
const OFFICIAL_RELEASE_PREFIX = "/getopenscreen/openscreen/releases/tag/";

interface ReleaseResponse {
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
}

type FetchLatestRelease = (
	url: string,
	init: {
		headers: Record<string, string>;
		signal?: AbortSignal;
	},
) => Promise<ReleaseResponse>;

interface ParsedVersion {
	major: bigint;
	minor: bigint;
	patch: bigint;
	prerelease: string[];
	normalized: string;
}

function parseVersion(value: string): ParsedVersion {
	const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
		value.trim(),
	);
	if (!match) throw new Error(`invalid semantic version: ${value}`);
	const prerelease = match[4]?.split(".") ?? [];
	const coreIdentifiers = [match[1], match[2], match[3]];
	if (
		[...coreIdentifiers, ...prerelease].some(
			(identifier) => /^\d+$/.test(identifier) && identifier.length > 1 && identifier[0] === "0",
		)
	) {
		throw new Error(`invalid semantic version: ${value}`);
	}
	const major = BigInt(match[1]);
	const minor = BigInt(match[2]);
	const patch = BigInt(match[3]);
	const core = `${major}.${minor}.${patch}`;
	return {
		major,
		minor,
		patch,
		prerelease,
		normalized: prerelease.length > 0 ? `${core}-${prerelease.join(".")}` : core,
	};
}

function comparePrerelease(left: string[], right: string[]): number {
	if (left.length === 0 || right.length === 0) {
		return left.length === right.length ? 0 : left.length === 0 ? 1 : -1;
	}
	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		const a = left[i];
		const b = right[i];
		if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1;
		if (a === b) continue;
		const aNumeric = /^\d+$/.test(a);
		const bNumeric = /^\d+$/.test(b);
		if (aNumeric && bNumeric) return BigInt(a) > BigInt(b) ? 1 : -1;
		if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
		return a > b ? 1 : -1;
	}
	return 0;
}

export function compareVersions(left: string, right: string): number {
	const a = parseVersion(left);
	const b = parseVersion(right);
	for (const key of ["major", "minor", "patch"] as const) {
		if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
	}
	return comparePrerelease(a.prerelease, b.prerelease);
}

function officialReleaseUrl(value: string, tag: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("untrusted release URL");
	}
	const encodedTag = url.pathname.slice(OFFICIAL_RELEASE_PREFIX.length);
	let decodedTag = "";
	try {
		decodedTag = decodeURIComponent(encodedTag);
	} catch {
		throw new Error("untrusted release URL");
	}
	if (
		url.protocol !== "https:" ||
		url.hostname !== "github.com" ||
		url.port !== "" ||
		!url.pathname.startsWith(OFFICIAL_RELEASE_PREFIX) ||
		decodedTag !== tag ||
		url.search !== "" ||
		url.hash !== ""
	) {
		throw new Error("untrusted release URL");
	}
	return url.toString();
}

export type UpdateCheckResult =
	| {
			kind: "available";
			currentVersion: string;
			latestVersion: string;
			releaseUrl: string;
	  }
	| {
			kind: "current";
			currentVersion: string;
			latestVersion: string;
	  };

interface Release {
	tag_name: string;
	html_url: string;
}

function isRelease(value: unknown): value is Release & { draft: boolean; prerelease: boolean } {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.tag_name === "string" &&
		typeof record.html_url === "string" &&
		typeof record.draft === "boolean" &&
		typeof record.prerelease === "boolean"
	);
}

function isValidVersion(value: string): boolean {
	try {
		parseVersion(value);
		return true;
	} catch {
		return false;
	}
}

function newestRelease(payload: unknown): Release {
	if (!Array.isArray(payload)) throw new Error("invalid GitHub release response");
	const candidates = payload.filter(
		(release): release is Release =>
			isRelease(release) && !release.draft && isValidVersion(release.tag_name),
	);
	if (candidates.length === 0) throw new Error("invalid GitHub release response");
	return candidates.reduce((newest, release) =>
		compareVersions(release.tag_name, newest.tag_name) > 0 ? release : newest,
	);
}

export async function checkLatestRelease(options: {
	currentVersion: string;
	fetchLatest: FetchLatestRelease;
	signal?: AbortSignal;
}): Promise<UpdateCheckResult> {
	const current = parseVersion(options.currentVersion);
	const onPrerelease = current.prerelease.length > 0;
	const response = await options.fetchLatest(
		onPrerelease ? RECENT_RELEASES_API : LATEST_RELEASE_API,
		{
			headers: {
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
			},
			...(options.signal ? { signal: options.signal } : {}),
		},
	);
	if (!response.ok) throw new Error(`GitHub release check failed (${response.status})`);

	const payload = await response.json();
	let release: Release;
	if (onPrerelease) {
		release = newestRelease(payload);
	} else {
		if (!isRelease(payload) || payload.draft || payload.prerelease) {
			throw new Error("invalid GitHub release response");
		}
		release = payload;
	}
	const latest = parseVersion(release.tag_name);
	const comparison = compareVersions(latest.normalized, current.normalized);
	if (comparison <= 0) {
		return {
			kind: "current",
			currentVersion: current.normalized,
			latestVersion: latest.normalized,
		};
	}

	return {
		kind: "available",
		currentVersion: current.normalized,
		latestVersion: latest.normalized,
		releaseUrl: officialReleaseUrl(release.html_url, release.tag_name),
	};
}
