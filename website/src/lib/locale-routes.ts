/**
 * The routes that exist in English only, in one place.
 *
 * Every page and doc is translated into every locale (docusaurus.config.ts
 * fails a build that misses one). The blog is the exception: it is a dated
 * development journal, so a non-en build switches the plugin off, and every
 * surface that a translated page shares with it has to know which URLs those
 * are:
 *
 *   - LocaleLink and the MDX link override, to send a reader to the English
 *     page with a plain <a hrefLang="en"> instead of a /fr/... URL that 404s;
 *   - SiteMetadata, to emit no hreflang alternates on a page that has none;
 *   - the locale dropdown, to send a reader to that locale's home instead (it
 *     does the same on the 404 page).
 */

export const BLOG_PATH = "/blog/";

/**
 * True for a site-root path (no locale segment) that only the English build
 * serves. Accepts the forms the site actually writes: with or without the
 * trailing slash ("/blog"), and with a hash or query.
 */
export function isEnglishOnlyPath(path: string): boolean {
	const bare = path.replace(/[?#].*$/, "");
	const slashed = bare.endsWith("/") ? bare : `${bare}/`;
	return slashed.startsWith(BLOG_PATH);
}
