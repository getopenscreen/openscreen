import type { Props } from "@theme/MDXComponents/A";
import A from "@theme-original/MDXComponents/A";
import type { ReactNode } from "react";

import LocaleLink from "../../components/LocaleLink";
import { isEnglishOnlyPath } from "../../lib/locale-routes";

/**
 * Markdown links in the docs go through LocaleLink when they point at an
 * English-only page. In a translated build, `[Auto zoom](/features/auto-zoom/)`
 * would otherwise render as /fr/features/auto-zoom/, a page that build does not
 * have, and onBrokenLinks fails it. That is true of a translated doc and of an
 * untranslated one, which Docusaurus publishes from the English source.
 */
export default function AWrapper(props: Props): ReactNode {
	const { href, ...rest } = props;
	if (href && isEnglishOnlyPath(href)) return <LocaleLink to={href} {...rest} />;
	return <A {...props} />;
}
