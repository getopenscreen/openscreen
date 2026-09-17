/**
 * Shape of the build-time release data, shared between the config that
 * resolves it (docusaurus.config.ts) and the pages that render it, which read
 * it back off siteConfig.customFields.
 */

export type ReleaseAsset = {
	name: string;
	url: string;
	size: number;
};

/** null whenever the build-time lookup failed; callers must handle it. */
export type LatestRelease = {
	tag: string;
	/** Pre-formatted at build time in the build's locale, e.g. "19 July 2026".
	 *  Empty if unknown. */
	published: string;
	/** The same date as YYYY-MM-DD, for structured data. Empty if unknown. */
	publishedIso: string;
	assets: ReleaseAsset[];
} | null;

/** One interface language of that release: its BCP 47 code in the app, and the
 *  name the app's language picker shows for it. */
export type AppLanguage = { lang: string; name: string };

/**
 * Asset filenames carry the version, so these match on the stable parts only —
 * platform, arch, and extension — and keep working across releases without a
 * config change.
 *
 * The .dmg names changed under these patterns once already: 1.7.0 shipped
 * Openscreen-Mac-arm64-1.7.0.dmg, 1.11.0 ships Openscreen-macOS-Apple-Silicon-
 * 1.11.0.dmg and Openscreen-macOS-Intel-1.11.0.dmg, and the old arm64/x64-only
 * patterns matched neither, so both macOS buttons fell back to the releases
 * list without anyone noticing. Both spellings are accepted, and
 * docusaurus.config.ts now fails the build when a kind matches nothing.
 */
export const ASSET_PATTERNS = {
	macArm: /mac.*(arm64|apple-silicon).*\.dmg$/i,
	macIntel: /mac.*(x64|intel).*\.dmg$/i,
	windows: /\.exe$/i,
	deb: /\.deb$/i,
	rpm: /\.rpm$/i,
	pacman: /\.pacman$/i,
	appImage: /\.AppImage$/i,
} as const;

export type AssetKind = keyof typeof ASSET_PATTERNS;

export function findAsset(release: LatestRelease, kind: AssetKind): ReleaseAsset | null {
	return release?.assets.find((a) => ASSET_PATTERNS[kind].test(a.name)) ?? null;
}
