import Head from "@docusaurus/Head";
import { useLocation } from "@docusaurus/router";
import { PageMetadata, useThemeConfig } from "@docusaurus/theme-common";
import { DEFAULT_SEARCH_TAG, useAlternatePageUtils } from "@docusaurus/theme-common/internal";
import useBaseUrl from "@docusaurus/useBaseUrl";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import { applyTrailingSlash } from "@docusaurus/utils-common";
import SearchMetadata from "@theme/SearchMetadata";
import React, { type ReactNode } from "react";

import { isEnglishOnlyPath } from "../../lib/locale-routes";

/*
 * Ejected from @docusaurus/theme-classic 3.10.1 (`swizzle --eject --danger`:
 * SiteMetadata is not on the theme's safe list, so re-check this file against
 * upstream on every Docusaurus upgrade). One change, in AlternateLangHeaders.
 *
 * Upstream emits an hreflang alternate for every locale on every page. The blog
 * is built in English only (src/lib/locale-routes.ts),
 * so on those routes each alternate pointed at a /fr/, /es/... URL that 404s,
 * which is the one hreflang error search engines report. Those routes now emit
 * no alternates at all, and no og:locale:alternate either, for the same reason.
 * So do the 404 pages, whose alternates would point at /fr/404.html/ and the
 * like, and a translated path shown by the English 404 page (see below).
 * og:locale stays. Every other route keeps the full upstream set.
 */

// TODO move to SiteMetadataDefaults or theme-common ?
// Useful for i18n/SEO
// See https://developers.google.com/search/docs/advanced/crawling/localized-versions
// See https://github.com/facebook/docusaurus/issues/3317
function AlternateLangHeaders(): ReactNode {
	const {
		i18n: { currentLocale, defaultLocale, localeConfigs },
	} = useDocusaurusContext();
	const alternatePageUtils = useAlternatePageUtils();
	// Root-relative in the English build, which is the only one that has these
	// routes: a translated build's paths start with its locale and never match.
	const { pathname } = useLocation();
	// GitHub Pages answers a missing /fr/... URL with the English 404.html, and
	// once it hydrates, the English build would prefix that path again
	// (/fr/fr/...). The locale menu spots the 404 by its route context; this
	// component renders outside the routes and has none, so it goes by the path.
	const underOtherLocale =
		currentLocale === defaultLocale &&
		Object.entries(localeConfigs).some(
			([locale, { baseUrl }]) => locale !== currentLocale && pathname.startsWith(baseUrl),
		);
	const hasAlternates =
		!isEnglishOnlyPath(pathname) && !underOtherLocale && !pathname.endsWith("/404.html");

	const currentHtmlLang = localeConfigs[currentLocale]!.htmlLang;

	// HTML lang is a BCP 47 tag, but the Open Graph protocol requires
	// using underscores instead of dashes.
	// See https://ogp.me/#optional
	// See https://en.wikipedia.org/wiki/IETF_language_tag)
	const bcp47ToOpenGraphLocale = (code: string): string => code.replace("-", "_");

	// Note: it is fine to use both "x-default" and "en" to target the same url
	// See https://www.searchviu.com/en/multiple-hreflang-tags-one-url/
	return (
		<Head>
			{hasAlternates &&
				Object.entries(localeConfigs).map(([locale, { htmlLang }]) => (
					<link
						key={locale}
						rel="alternate"
						href={alternatePageUtils.createUrl({
							locale,
							fullyQualified: true,
						})}
						hrefLang={htmlLang}
					/>
				))}
			{hasAlternates && (
				<link
					rel="alternate"
					href={alternatePageUtils.createUrl({
						locale: defaultLocale,
						fullyQualified: true,
					})}
					hrefLang="x-default"
				/>
			)}

			<meta property="og:locale" content={bcp47ToOpenGraphLocale(currentHtmlLang)} />
			{Object.values(localeConfigs)
				.filter((config) => hasAlternates && currentHtmlLang !== config.htmlLang)
				.map((config) => (
					<meta
						key={`meta-og-${config.htmlLang}`}
						property="og:locale:alternate"
						content={bcp47ToOpenGraphLocale(config.htmlLang)}
					/>
				))}
		</Head>
	);
}

// Default canonical url inferred from current page location pathname
function useDefaultCanonicalUrl() {
	const {
		siteConfig: { url: siteUrl, baseUrl, trailingSlash },
	} = useDocusaurusContext();

	// TODO using useLocation().pathname is not a super idea
	// See https://github.com/facebook/docusaurus/issues/9170
	const { pathname } = useLocation();

	const canonicalPathname = applyTrailingSlash(useBaseUrl(pathname), {
		trailingSlash,
		baseUrl,
	});

	return siteUrl + canonicalPathname;
}

// TODO move to SiteMetadataDefaults or theme-common ?
function CanonicalUrlHeaders({ permalink }: { permalink?: string }) {
	const {
		siteConfig: { url: siteUrl },
	} = useDocusaurusContext();
	const defaultCanonicalUrl = useDefaultCanonicalUrl();

	const canonicalUrl = permalink ? `${siteUrl}${permalink}` : defaultCanonicalUrl;
	return (
		<Head>
			<meta property="og:url" content={canonicalUrl} />
			<link rel="canonical" href={canonicalUrl} />
		</Head>
	);
}

export default function SiteMetadata(): ReactNode {
	const {
		i18n: { currentLocale },
	} = useDocusaurusContext();

	// TODO maybe move these 2 themeConfig to siteConfig?
	// These seems useful for other themes as well
	const { metadata, image: defaultImage } = useThemeConfig();

	return (
		<>
			<Head>
				<meta name="twitter:card" content="summary_large_image" />
				{/* The keyboard focus class name need to be applied when SSR so links
        are outlined when JS is disabled */}
				<body />
			</Head>

			{defaultImage && <PageMetadata image={defaultImage} />}

			<CanonicalUrlHeaders />

			<AlternateLangHeaders />

			<SearchMetadata tag={DEFAULT_SEARCH_TAG} locale={currentLocale} />

			{/*
        It's important to have an additional <Head> element here, as it allows
        react-helmet to override default metadata values set in previous <Head>
        like "twitter:card". In same Head, the same meta would appear twice
        instead of overriding.
      */}
			<Head>
				{/* Yes, "metadatum" is the grammatically correct term */}
				{metadata.map((metadatum, i) => (
					<meta key={i} {...metadatum} />
				))}
			</Head>
		</>
	);
}
