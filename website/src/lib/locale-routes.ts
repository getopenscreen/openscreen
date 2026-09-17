/**
 * The routes that exist in English only, in one place.
 *
 * Translated locales ship the landing page, /download/ and the docs. The blog
 * and the marketing pages below stay English: the blog is a dated development
 * journal, and the comparison pages carry vendor facts checked in English. A
 * non-en build therefore drops them (docusaurus.config.ts), and every surface
 * that a translated page shares with them has to know which URLs those are:
 *
 *   - the config, to exclude the page files and switch the blog off;
 *   - LocaleLink and the MDX link override, to send a reader to the English
 *     page with a plain <a hrefLang="en"> instead of a /fr/... URL that 404s;
 *   - SiteMetadata, to emit no hreflang alternates on a page that has none;
 *   - the locale dropdown, to send a reader to that locale's home instead (it
 *     does the same on the 404 page).
 *
 * The URL prefix and the source glob of each page family sit on the same line
 * so that adding a family, or translating one, is a one-line change that both
 * sides see. The blog has no glob: it is a plugin, switched off as a whole.
 */

export const ENGLISH_ONLY_PAGES = [
	{ path: "/alternatives/", glob: "alternatives/**" },
	{ path: "/compare/", glob: "compare/**" },
	{ path: "/features/", glob: "features/**" },
	{ path: "/screen-recorder-", glob: "screen-recorder-*.mdx" },
] as const;

export const BLOG_PATH = "/blog/";

/** Globs relative to src/pages, for the pages plugin's `exclude`. */
export const ENGLISH_ONLY_PAGE_GLOBS = ENGLISH_ONLY_PAGES.map((page) => page.glob);

const ENGLISH_ONLY_PREFIXES = [BLOG_PATH, ...ENGLISH_ONLY_PAGES.map((page) => page.path)];

/**
 * True for a site-root path (no locale segment) that only the English build
 * serves. Accepts the forms the site actually writes: with or without the
 * trailing slash ("/blog"), and with a hash or query.
 */
export function isEnglishOnlyPath(path: string): boolean {
	const bare = path.replace(/[?#].*$/, "");
	const slashed = bare.endsWith("/") ? bare : `${bare}/`;
	return ENGLISH_ONLY_PREFIXES.some((prefix) => slashed.startsWith(prefix));
}
