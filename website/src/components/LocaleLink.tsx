import Link from "@docusaurus/Link";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import type { ComponentProps } from "react";

import { isEnglishOnlyPath } from "../lib/locale-routes";

type Props = Omit<ComponentProps<"a">, "href" | "ref"> & { to: string };

/**
 * A site link that still works from a translated page when its target exists in
 * English only (src/lib/locale-routes.ts).
 *
 * @docusaurus/Link cannot do that on its own. It prefixes every root-relative
 * URL with the current locale's baseUrl, so /blog/ becomes /fr/blog/, which a
 * French build does not have: onBrokenLinks fails the build on it. The
 * documented escape, `pathname://`, still gets the prefix, and on top of that
 * the link counts as external and opens in a new tab. So outside English the
 * link is a plain anchor: no baseUrl, no client-side routing (the target is not
 * a route of this build), and hrefLang to say the page is English.
 *
 * In English, and for every translated target, it is the ordinary Link, which
 * keeps prefetching and the broken-link check.
 */
export default function LocaleLink({ to, ...props }: Props) {
	const { i18n } = useDocusaurusContext();
	if (i18n.currentLocale === i18n.defaultLocale || !isEnglishOnlyPath(to)) {
		return <Link to={to} {...props} />;
	}
	return <a href={to} hrefLang="en" {...props} />;
}
