import Translate from "@docusaurus/Translate";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import { Fragment } from "react";

import type { AppLanguage } from "../lib/release";

/**
 * "Interface in 13 languages: English, عربي, …", from the release the site
 * serves (see readAppLanguages in docusaurus.config.ts), on the two pages that
 * are about the product.
 *
 * Each name is written in its own language, so each carries its own lang: a
 * screen reader otherwise reads 日本語 with the page's voice. <bdi> keeps the
 * Arabic name from reordering the commas around it.
 */
export default function AppLanguages({ className }: { className?: string }) {
	const { siteConfig } = useDocusaurusContext();
	const languages = (siteConfig.customFields?.appLanguages ?? []) as AppLanguage[];
	if (languages.length === 0) return null;

	return (
		<p className={className}>
			<Translate
				id="appLanguages.line"
				description="{count} is a number; {names} is the list of language names, each in its own language"
				values={{
					count: languages.length,
					// One element, not an array: interpolate() joins arrays as text.
					names: (
						<>
							{languages.map(({ lang, name }, i) => (
								<Fragment key={lang}>
									{i > 0 && ", "}
									<bdi lang={lang}>{name}</bdi>
								</Fragment>
							))}
						</>
					),
				}}
			>
				{"Interface in {count} languages: {names}"}
			</Translate>
		</p>
	);
}
