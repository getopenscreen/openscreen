import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type * as Preset from "@docusaurus/preset-classic";
import type { Config } from "@docusaurus/types";
import { themes as prismThemes } from "prism-react-renderer";

import { BLOG_PATH } from "./src/lib/locale-routes";
import {
	type AppLanguage,
	ASSET_PATTERNS,
	type AssetKind,
	findAsset,
	type LatestRelease,
} from "./src/lib/release";

const SITE_URL = "https://getopenscreen.com";
const REPO_SLUG = "getopenscreen/openscreen";
const REPO_URL = `https://github.com/${REPO_SLUG}`;
// The served form. static/discord/index.html is a directory index, so Pages
// answers /discord with a 301 to /discord/, and every page linked the hop.
const DISCORD_URL = "https://getopenscreen.com/discord/";
// The app's repository; this site lives in its website/ directory.
const APP_ROOT = path.resolve(__dirname, "..");

// pt-BR, zh-CN and zh-TW get an explicit lowercase baseUrl: the inferred one is
// /pt-BR/, and GitHub Pages matches paths case-sensitively, so /pt-br/ (the form
// people and tools lowercase URLs to) would 404. `path` stays the default, so
// their translations live in i18n/pt-BR/, i18n/zh-CN/ and i18n/zh-TW/.
// The Chinese labels are the app's language picker's. Docusaurus has no zh-CN or
// zh-TW theme strings, and falls back to the script of the maximized tag:
// zh-Hans and zh-Hant (codeTranslationLocalesToTry, theme-translations 3.10.1).
// Adding a locale here also means a Sitemap line in static/robots.txt: each
// locale build writes its own sitemap, and nothing lists them for crawlers.
const LOCALE_CONFIGS: Record<string, { label: string; htmlLang: string; baseUrl?: string }> = {
	en: { label: "English", htmlLang: "en" },
	fr: { label: "Français", htmlLang: "fr" },
	es: { label: "Español", htmlLang: "es" },
	"pt-BR": { label: "Português (Brasil)", htmlLang: "pt-BR", baseUrl: "/pt-br/" },
	ja: { label: "日本語", htmlLang: "ja" },
	"zh-CN": { label: "简体中文", htmlLang: "zh-CN", baseUrl: "/zh-cn/" },
	"zh-TW": { label: "繁體中文", htmlLang: "zh-TW", baseUrl: "/zh-tw/" },
	de: { label: "Deutsch", htmlLang: "de" },
};

// Docusaurus loads this module afresh for every locale it builds, and sets this
// variable first (core/lib/commands/build/buildLocale.js, start/start.js). It is
// unset on the initial load that only reads the locale list, hence the default.
// `start` without --locale assigns it undefined, which process.env stores as
// the string "undefined": hence the lookup rather than a bare `??`, which would
// have run `npm run dev` as a translated build with no blog.
// `write-translations` does not set it at all: run it with the variable set
// (website/i18n/TRANSLATING.md), or it extracts the English build's strings.
const ENV_LOCALE = process.env.DOCUSAURUS_CURRENT_LOCALE ?? "";
const LOCALE = Object.hasOwn(LOCALE_CONFIGS, ENV_LOCALE) ? ENV_LOCALE : "en";
const HTML_LANG = LOCALE_CONFIGS[LOCALE]?.htmlLang ?? LOCALE;

// Kept under ~155 characters: past that, Google truncates the snippet mid-word.
const SITE_DESCRIPTION =
	"Free, open-source screen recorder and video editor for Windows, macOS, and Linux. Native capture, on-device captions, no watermarks, no subscriptions.";

// Site-wide structured data. Organization + WebSite are true of every page, so
// they belong here; the SoftwareApplication entity describes the product rather
// than the site and lives in src/lib/structured-data.ts, emitted only by the two
// pages that are about the product (the landing page and /download), because
// repeating it under every docs URL is what earns a manual action.
const ORGANIZATION_LD = {
	"@context": "https://schema.org",
	"@type": "Organization",
	"@id": `${SITE_URL}/#organization`,
	name: "OpenScreen",
	url: SITE_URL,
	logo: `${SITE_URL}/img/logo-icon.png`,
	description: SITE_DESCRIPTION,
	// Identities only. The archived original belongs to someone else, so it is
	// the SoftwareApplication's isBasedOn (src/lib/structured-data.ts), not a
	// sameAs of this organization. The Discord link is left out: /discord/ is a
	// redirect page on this domain, and the invite behind it rotates.
	sameAs: [REPO_URL],
};

const WEBSITE_LD = {
	"@context": "https://schema.org",
	"@type": "WebSite",
	"@id": `${SITE_URL}/#website`,
	name: "OpenScreen",
	url: SITE_URL,
	description: SITE_DESCRIPTION,
	// Every locale build emits this node under the same @id, so it says the same
	// thing in each: one site in all its languages. The build's own language would
	// have the builds disagree about one entity (src/lib/structured-data.ts).
	inLanguage: Object.values(LOCALE_CONFIGS).map((config) => config.htmlLang),
	publisher: { "@id": `${SITE_URL}/#organization` },
};

const STAR_SVG =
	'<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/></svg>';

function formatStarCount(count: number): string {
	if (count < 1000) return String(count);
	return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}

// Unauthenticated calls share a 60-per-hour limit per runner IP. CI passes the
// workflow's own token (.github/workflows/docs.yml); a local build runs without.
const GITHUB_HEADERS: Record<string, string> = {
	Accept: "application/vnd.github+json",
	...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
};

// GitHub's own embeddable widgets (the buttons.github.io <a class="github-button">
// script, or a shields.io <img> badge) are live but render as an iframe / raster
// image neither of which can match the design's inline text+icon pixel spec. This
// fetches the real count once at build time instead, so the number stays live
// across deploys without faking data or fighting a third-party widget's styling.
async function fetchStarCount(): Promise<number | null> {
	try {
		const res = await fetch(`https://api.github.com/repos/${REPO_SLUG}`, {
			headers: GITHUB_HEADERS,
			signal: AbortSignal.timeout(5000),
		});
		if (!res.ok) return null;
		const data = (await res.json()) as { stargazers_count?: unknown };
		return typeof data.stargazers_count === "number" ? data.stargazers_count : null;
	} catch {
		return null;
	}
}

/**
 * The published assets for the current stable release, resolved at build time
 * so /download can link each platform to its actual file instead of bouncing
 * everyone through the releases list.
 *
 * This is only safe because .github/workflows/build.yml dispatches docs.yml
 * against main after `gh release create` has uploaded the assets, on every
 * stable release. Without that dispatch the data would go stale silently: the
 * workflow otherwise only fires on website/** changes, so shipping a new
 * version would leave this page advertising the previous one indefinitely.
 * The asset check in createConfig relies on that order too.
 *
 * Returns null on any failure (a local build calls the API unauthenticated, so
 * a rate limit is a real possibility); the page falls back to /releases/latest
 * links, which are always correct.
 *
 * The display date is left to createConfig, which formats it per locale.
 */
async function fetchLatestRelease(): Promise<Omit<NonNullable<LatestRelease>, "published"> | null> {
	try {
		const res = await fetch(`https://api.github.com/repos/${REPO_SLUG}/releases/latest`, {
			headers: GITHUB_HEADERS,
			signal: AbortSignal.timeout(5000),
		});
		if (!res.ok) return null;
		const data = (await res.json()) as {
			tag_name?: unknown;
			published_at?: unknown;
			assets?: unknown;
		};
		if (typeof data.tag_name !== "string" || !Array.isArray(data.assets)) return null;

		const assets = data.assets.flatMap((raw) => {
			const a = raw as { name?: unknown; browser_download_url?: unknown; size?: unknown };
			if (typeof a.name !== "string" || typeof a.browser_download_url !== "string") return [];
			return [{ name: a.name, url: a.browser_download_url, size: Number(a.size) || 0 }];
		});
		if (assets.length === 0) return null;

		// schema.org's Date form, for /download's structured data, and the
		// input of the display date.
		const publishedIso =
			typeof data.published_at === "string" && /^\d{4}-\d{2}-\d{2}/.test(data.published_at)
				? data.published_at.slice(0, 10)
				: "";

		return { tag: data.tag_name, publishedIso, assets };
	} catch {
		return null;
	}
}

/**
 * The interface languages of the release /download/ serves, each under the name
 * it gives itself in the app's language picker.
 *
 * Read at the release tag rather than from the working tree: main can list a
 * language before any stable release ships it (Czech was on main while 1.11.0
 * was current), and this line sits on the page that downloads the release.
 * Without the tag (the lookup failed, or a checkout without tags) it falls back
 * to the working tree, and says so in the build log.
 *
 * The names are the app's own `locale.name` strings, not Intl.DisplayNames:
 * Intl calls ja-JP "日本語 (日本)" and the two Chinese locales "中文（中国）" and
 * "中文（台灣）", where the picker says 日本語, 简体中文 and 繁體中文, and no rule
 * short of a per-language exception list gets from one to the other.
 */
function readAppLanguages(tag: string | undefined): AppLanguage[] {
	if (!tag) console.warn("[config] no release tag; interface languages read from the working tree");
	let ref = tag;
	const read = (file: string): string => {
		if (ref) {
			try {
				return execFileSync("git", ["show", `${ref}:${file}`], {
					cwd: APP_ROOT,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
				});
			} catch {
				console.warn(`[config] ${file} is not readable at ${ref}; using the working tree`);
				ref = undefined;
			}
		}
		return readFileSync(path.join(APP_ROOT, file), "utf8");
	};
	const list = read("src/i18n/config.ts").match(/SUPPORTED_LOCALES = \[([^\]]*)\]/)?.[1];
	if (!list) throw new Error("SUPPORTED_LOCALES not found in src/i18n/config.ts");
	return [...list.matchAll(/"([^"]+)"/g)].map(([, lang]) => {
		const strings = JSON.parse(read(`src/i18n/locales/${lang}/common.json`));
		const name: unknown = strings?.locale?.name;
		if (typeof name !== "string") throw new Error(`no locale.name in the app's ${lang} strings`);
		return { lang, name };
	});
}

// The two @rspack/core minimizers the rspack-minimizers plugin adjusts, reduced
// to what it touches: the options each instance was constructed with.
type RspackMinimizer<Options> = abstract new (...args: never[]) => { _args: [Options] };
type RspackMinimizers = {
	SwcJsMinimizerRspackPlugin: RspackMinimizer<{ extractComments?: boolean }>;
	LightningCssMinimizerRspackPlugin: RspackMinimizer<{
		minimizerOptions: { include?: { mediaRangeSyntax?: boolean } };
	}>;
};

type BuildLookups = {
	starCount: number | null;
	release: Awaited<ReturnType<typeof fetchLatestRelease>>;
	appLanguages: AppLanguage[];
};

// This module is evaluated once to read the locale list and then once per
// locale, so a module-level cache would not survive; globalThis does, for the
// life of the process. Without it a five-locale build made twelve API calls,
// and one that failed dropped the star badge from that locale alone. The price
// is a `start` session that keeps the numbers it began with.
const cache = globalThis as typeof globalThis & {
	__openscreenBuildLookups?: Promise<BuildLookups>;
};

function buildLookups(): Promise<BuildLookups> {
	cache.__openscreenBuildLookups ??= Promise.all([fetchStarCount(), fetchLatestRelease()]).then(
		([starCount, release]) => ({
			starCount,
			release,
			appLanguages: readAppLanguages(release?.tag),
		}),
	);
	return cache.__openscreenBuildLookups;
}

/**
 * Docusaurus serves the English source for any doc or Markdown page a locale
 * lacks, under /<locale>/ with that locale's lang and hreflang: an English page
 * that says it is French. A new English doc or page would reach every locale
 * that way with no warning, so a build refuses it. Excluding the file instead
 * is not an option for docs (sidebars.ts names them by id), and keeping one
 * rule for both is simpler than a per-locale exclusion list. `start` only
 * warns, so a translator can preview a locale half done. The .tsx pages are
 * translated through code.json and are not listed here.
 */
const TRANSLATED_SOURCES = [
	{ source: "docs", target: "docusaurus-plugin-content-docs/current" },
	{ source: "src/pages", target: "docusaurus-plugin-content-pages" },
];

function checkTranslations(): void {
	if (LOCALE === "en") return;
	const missing = TRANSLATED_SOURCES.flatMap(({ source, target }) =>
		readdirSync(path.join(__dirname, source), { recursive: true, encoding: "utf8" })
			.filter((file) => /\.mdx?$/.test(file))
			.filter((file) => !existsSync(path.join(__dirname, "i18n", LOCALE, target, file)))
			.map((file) => path.posix.join(source, file.replaceAll("\\", "/"))),
	);
	if (missing.length === 0) return;
	const message = `[config] ${LOCALE} has no translation of ${missing.join(", ")}; see i18n/TRANSLATING.md`;
	if (process.env.NODE_ENV === "production") throw new Error(message);
	console.warn(message);
}

export default async function createConfig(): Promise<Config> {
	checkTranslations();
	const { starCount, release, appLanguages } = await buildLookups();
	// Formatted here rather than in the component: toLocaleDateString would
	// resolve against the visitor's locale and time zone on hydration and
	// mismatch the server-rendered string. UTC, because the ISO date is UTC.
	// English stays en-GB: the page said "9 September 2026" before it was
	// translated, and plain "en" is the US order.
	const latestRelease: LatestRelease = release && {
		...release,
		published: release.publishedIso
			? new Intl.DateTimeFormat(LOCALE === "en" ? "en-GB" : HTML_LANG, {
					day: "numeric",
					month: "long",
					year: "numeric",
					timeZone: "UTC",
				}).format(new Date(`${release.publishedIso}T00:00:00Z`))
			: "",
	};
	// A lookup that failed is an outage and degrades to /releases/latest. A lookup
	// that succeeded but cannot place one of the artifacts is a renamed file, and
	// that is not allowed to degrade: it is how both macOS buttons pointed at the
	// releases list for a whole release without anyone noticing. Failing here is
	// one line in the build log instead of a page that looks fine.
	if (latestRelease) {
		const missing = (Object.keys(ASSET_PATTERNS) as AssetKind[]).filter(
			(kind) => !findAsset(latestRelease, kind),
		);
		if (missing.length > 0) {
			throw new Error(
				`${latestRelease.tag} has no asset matching ${missing.join(", ")}; update ASSET_PATTERNS in src/lib/release.ts`,
			);
		}
	}
	const starBadge =
		starCount !== null
			? `<span class="navbar-github-stars">${STAR_SVG}${formatStarCount(starCount)}</span>`
			: "";

	return {
		title: "OpenScreen",
		tagline: "A free, open-source screen recorder and editor.",
		favicon: "img/logo-icon.png",

		// Pages serves this from the custom domain's root, not from
		// getopenscreen.github.io/openscreen/, so baseUrl has to be "/" — a project
		// baseUrl would prefix every asset URL with a path the server has nothing at.
		url: SITE_URL,
		baseUrl: "/",

		// Every page is emitted as <route>/index.html, and GitHub Pages 301s the
		// extensionless form to the trailing-slash one. Leaving this unset makes
		// Docusaurus advertise the pre-redirect URL in both <link rel="canonical">
		// and sitemap.xml, so every indexed URL costs a crawler an extra hop to a
		// URL that isn't the one we declared canonical. Declaring the served form
		// removes the redirect from the canonical path entirely.
		trailingSlash: true,

		organizationName: "getopenscreen",
		projectName: "openscreen",

		// Read back by src/pages/download.tsx, src/pages/index.tsx and
		// src/components/AppLanguages.
		// Serialized into the client bundle, so it stays plain JSON.
		customFields: { latestRelease, appLanguages },

		// Translated: the landing page, /download/, the docs and the theme. The
		// blog and the marketing pages stay English (src/lib/locale-routes.ts).
		// No redirect on Accept-Language: every locale is its own URL.
		i18n: {
			defaultLocale: "en",
			locales: Object.keys(LOCALE_CONFIGS),
			localeConfigs: LOCALE_CONFIGS,
		},

		onBrokenLinks: "throw",
		onBrokenAnchors: "throw",

		markdown: {
			// Translated docs keep each English heading's anchor with an explicit
			// `## Titre {#english-slug}`, so #links survive translation. That
			// syntax needs this flag. It is the default today, and turning on
			// `future.v4` would switch it off.
			mdx1Compat: { headingIds: true },
			hooks: {
				onBrokenMarkdownLinks: "warn",
			},
		},

		// Docusaurus Faster (Rspack, SWC, Lightning CSS). Each of the eight locales
		// is a full build of its own, and bundling is most of `npm run build`.
		// Measured locally on Windows, not on CI: with no cache, as in CI, the full
		// build took 2m54s to 3m02s with webpack and 29s to 52s with this; with a
		// warm cache, about 23s either way. The output matches the webpack build's
		// once the rspack-minimizers plugin below and the two flags turned off here
		// are in place. ssgWorkerThreads is left out: Docusaurus only starts worker
		// threads above 100 pages per locale (the English build has 42), and it
		// needs a future.v4 flag.
		future: {
			faster: {
				swcJsLoader: true,
				swcJsMinimizer: true,
				lightningCssMinimizer: true,
				mdxCrossCompilerCache: true,
				rspackBundler: true,
				rspackPersistentCache: true,
				// Its HTML parser turns the NUL bytes React leaves in an attribute into
				// U+FFFD before fix-build-output can drop them: 19 ja, zh and pt-BR pages
				// had one in a sidebar title="…" or an aria-label.
				swcHtmlMinimizer: false,
				// The eager Git reader keys files by absolute path, and the sitemap asks
				// for a .tsx page by relative path: / and /download/ lost <lastmod>.
				gitEagerVcs: false,
			},
		},

		headTags: [
			{
				tagName: "link",
				attributes: {
					rel: "apple-touch-icon",
					sizes: "180x180",
					href: "/img/apple-touch-icon.png",
				},
			},
			{
				tagName: "script",
				attributes: { type: "application/ld+json" },
				innerHTML: JSON.stringify(ORGANIZATION_LD),
			},
			{
				tagName: "script",
				attributes: { type: "application/ld+json" },
				innerHTML: JSON.stringify(WEBSITE_LD),
			},
		],

		// One plugin, two steps in order: Docusaurus runs every plugin's postBuild
		// at once, and the second step reads files the first one deletes.
		plugins: [
			() => ({
				name: "fix-build-output",
				async postBuild({ outDir }) {
					// static/ is copied into every locale's build, and some of it only
					// means something at the site root. static/blog/ holds a redirect
					// for a renamed tag: a translated build has no blog, so that copy
					// would be the only thing under /fr/blog/, a page nothing links to,
					// redirecting a French URL to an English one. /fr/discord/ would be
					// a second, unlinked copy of the invite redirect, and crawlers read
					// llms.txt and robots.txt at the root only. The rest (img, video)
					// stays: pages resolve images through the locale's baseUrl.
					if (LOCALE !== "en") {
						for (const entry of [BLOG_PATH, "discord", "llms.txt", "robots.txt"]) {
							await rm(path.join(outDir, entry), { recursive: true, force: true });
						}
					}

					// React 18.3.1's streaming renderer, which Docusaurus renders every
					// page through, flushes its whole 2048-byte buffer when the next
					// multibyte character does not fit in what is left of it, unwritten
					// zero bytes included (writeStringChunk in react-dom-server.node).
					// A page then carries one or two NUL bytes wherever a non-ASCII
					// character straddles a buffer boundary: the one on the live
					// /docs/export/, and several per page in Japanese, where every
					// character is multibyte. The character itself is intact, encoded
					// again after the padding, so dropping the NULs gives back the exact
					// markup. Left in, the HTML parser turns one inside an attribute
					// (the sidebar's title="…") into U+FFFD, and grep and file take the
					// page for binary. Remove this once the site is on React 19.
					const files = await readdir(outDir, { recursive: true });
					for (const file of files.filter((name) => name.endsWith(".html"))) {
						const target = path.join(outDir, file);
						const html = await readFile(target, "utf8");
						if (html.includes("\0")) await writeFile(target, html.replaceAll("\0", ""));
					}
				},
			}),
			// Rspack's minimizers, as Docusaurus Faster builds them, change two things
			// the webpack ones did not, and Docusaurus takes no option for either, so
			// this edits the options each instance keeps in `_args` until Rspack
			// applies it. Recheck on a Docusaurus or Rspack upgrade. SWC dropped the
			// license comments of the bundled libraries (React, NProgress, lucide),
			// which Terser moved to *.js.LICENSE.txt. Lightning CSS wrote every
			// `min-width` query in range syntax, which UC Browser 15.5, a browserslist
			// target that Lightning CSS cannot target, does not read.
			() => ({
				name: "rspack-minimizers",
				configureWebpack(config, isServer, { currentBundler }) {
					if (isServer || currentBundler.name !== "rspack") return {};
					const rspack = currentBundler.instance as unknown as RspackMinimizers;
					for (const plugin of config.optimization?.minimizer ?? []) {
						if (plugin instanceof rspack.SwcJsMinimizerRspackPlugin) {
							plugin._args[0].extractComments = true;
						} else if (plugin instanceof rspack.LightningCssMinimizerRspackPlugin) {
							plugin._args[0].minimizerOptions.include = { mediaRangeSyntax: true };
						}
					}
					return {};
				},
			}),
		],

		presets: [
			[
				"@docusaurus/preset-classic",
				{
					docs: {
						sidebarPath: "./sidebars.ts",
						editUrl: `${REPO_URL}/tree/main/website/`,
						// "Edit this page" on a translated doc opens the translation,
						// not the English source. Docusaurus decides per file, so a
						// doc still served from the English source keeps that link.
						editLocalizedFiles: true,
						// The page's own git date, shown and carried as dateModified.
						// Needs the full-history checkout in .github/workflows/docs.yml.
						showLastUpdateTime: true,
					},
					// A development journal, not a marketing blog. Each post is dated to
					// the milestone it covers, so the list reads as a timeline. English
					// only: a translated build has no blog at all, rather than one that
					// republishes the English posts under /fr/blog/.
					blog:
						LOCALE !== "en"
							? false
							: {
									routeBasePath: "blog",
									blogTitle: "OpenScreen development journal",
									blogDescription:
										"Release notes with the reasoning attached, from the maintainer of OpenScreen, the community-maintained continuation of the open-source screen recorder.",
									showReadingTime: true,
									// Same source as the docs' date: git history of the post file.
									showLastUpdateTime: true,
									postsPerPage: "ALL",
									blogSidebarCount: "ALL",
									blogSidebarTitle: "All posts",
									feedOptions: {
										type: "all",
										title: "OpenScreen development journal",
										description:
											"What I have shipped since picking OpenScreen up in June 2026, and what broke along the way.",
									},
								},
					// The MDX landing pages carry dated vendor facts; show their git date.
					pages: {
						showLastUpdateTime: true,
					},
					theme: {
						customCss: "./src/css/custom.css",
					},
					sitemap: {
						// Off by default in Docusaurus 3. Sourced from git history, it
						// gives crawlers a real freshness signal per URL instead of one
						// undated blob that has to be re-fetched to find out what moved.
						// Only with full history: a shallow checkout gives every file
						// the deployed commit's date, which is what shipped until
						// .github/workflows/docs.yml set fetch-depth: 0.
						lastmod: "date",
						// Tag, author and archive pages list posts and say nothing of
						// their own; most tags hold one post. They stay crawlable
						// through the blog's links, but a sitemap is a list of pages
						// worth indexing, and near-empty ones dilute it (10 of the 27
						// URLs when this was added).
						ignorePatterns: ["/blog/tags/**", "/blog/authors/**", "/blog/archive/**"],
						changefreq: "weekly",
						priority: 0.5,
						createSitemapItems: async ({ defaultCreateSitemapItems, ...rest }) => {
							const items = await defaultCreateSitemapItems(rest);
							// Flat 0.5 everywhere tells a crawler nothing. The landing page
							// and the docs entry point are the two URLs worth ranking, in
							// every locale: siteConfig.baseUrl is this build's (/fr/...).
							const home = `${SITE_URL}${rest.siteConfig.baseUrl}`;
							return items.map((item) => {
								if (item.url === home) return { ...item, priority: 1.0 };
								if (item.url === `${home}docs/intro/`) return { ...item, priority: 0.8 };
								return { ...item, priority: 0.7 };
							});
						},
					},
				} satisfies Preset.Options,
			],
		],

		themeConfig: {
			// 1200x630, fully opaque. Docusaurus hardcodes twitter:card as
			// summary_large_image, which crops to 1.91:1 — the old square app icon was
			// letterboxed or cropped by every client. Opaque also still matters: an
			// og:image with alpha gets composited on whatever background the platform
			// picks, so a transparent mark turns into a green smear on some clients.
			image: "img/og-image.png",
			// Docusaurus emits og:title/description/url/image and twitter:card on its
			// own, but never og:type or og:site_name — without them Facebook and
			// LinkedIn fall back to a bare link preview. The robots directives lift
			// Google's default 160-char snippet cap and thumbnail size limit.
			metadata: [
				{ name: "description", content: SITE_DESCRIPTION },
				{
					name: "keywords",
					content:
						"screen recorder, open source screen recorder, free screen recorder, video editor, screen recording software, screen capture, Windows, macOS, Linux, Screen Studio alternative, automatic captions, subtitles, Whisper, MIT license",
				},
				{ name: "robots", content: "index, follow, max-image-preview:large, max-snippet:-1" },
				{ property: "og:type", content: "website" },
				{ property: "og:site_name", content: "OpenScreen" },
				{ name: "twitter:image:alt", content: "OpenScreen — free, open-source screen recorder" },
			],
			colorMode: {
				defaultMode: "dark",
				disableSwitch: false,
				respectPrefersColorScheme: false,
			},
			navbar: {
				title: "OpenScreen",
				logo: {
					// Explicit intrinsic size: without it the navbar reserves no space
					// for the mark and the whole bar reflows once the PNG decodes.
					alt: "OpenScreen logo",
					src: "img/logo-icon.png",
					width: 32,
					height: 32,
				},
				items: [
					{
						type: "docSidebar",
						sidebarId: "mainSidebar",
						position: "left",
						label: "Docs",
						className: "navbar-link-strong",
					},
					LOCALE === "en"
						? {
								// A router link (not href) so it gets SPA navigation and route
								// prefetch, like the Download CTA below.
								to: "/blog",
								label: "Blog",
								position: "left",
								className: "navbar-link-strong",
							}
						: {
								// A translated build has no blog, so this leaves for the English
								// one. `to: "/blog"` would render /fr/blog/ and fail the
								// broken-link check, and a bare href gets the same prefix from
								// @docusaurus/Link. `pathname://` with autoAddBaseUrl off is how
								// the stock locale dropdown links across builds, and target
								// overrides the _blank that Link gives any non-router URL. An
								// html item would do without these, but it has no label, and
								// only a label is translated through navbar.json. Link's
								// external-link glyph is hidden by custom.css, as on the others.
								href: `pathname://${BLOG_PATH}`,
								autoAddBaseUrl: false,
								target: "_self",
								hrefLang: "en",
								label: "Blog",
								position: "left",
								className: "navbar-link-strong",
							},
					{
						href: `${REPO_URL}/blob/main/ROADMAP.md`,
						label: "Roadmap",
						position: "left",
					},
					{
						href: DISCORD_URL,
						label: "Discord",
						position: "left",
					},
					{ type: "localeDropdown", position: "right" },
					{
						type: "html",
						position: "right",
						value:
							`<a class="navbar-github-link" href="${REPO_URL}" target="_blank" rel="noopener noreferrer">` +
							'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/></svg>' +
							`GitHub${starBadge}</a>`,
					},
					{
						// Points at our own page now, not straight out to Releases, which
						// means it can be a real router link: SPA navigation plus route
						// prefetch, neither of which a raw <a> in an html item gets. A
						// link item only takes a string label, so the download glyph moves
						// to a CSS mask on .navbar-download-cta.
						to: "/download",
						label: "Download",
						className: "navbar-download-cta",
						position: "right",
					},
				],
			},
			prism: {
				theme: prismThemes.github,
				darkTheme: prismThemes.dracula,
			},
		} satisfies Preset.ThemeConfig,
	};
}
