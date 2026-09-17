import { useLocation } from "@docusaurus/router";
import { translate } from "@docusaurus/Translate";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import useRouteContext from "@docusaurus/useRouteContext";
import IconLanguage from "@theme/Icon/Language";
import DropdownNavbarItem from "@theme/NavbarItem/DropdownNavbarItem";
import type { Props } from "@theme/NavbarItem/LocaleDropdownNavbarItem";
import LocaleDropdownNavbarItem from "@theme-original/NavbarItem/LocaleDropdownNavbarItem";
import type { ReactNode } from "react";

import { isEnglishOnlyPath } from "../../../lib/locale-routes";

/**
 * The stock dropdown links each locale to the current page under that locale's
 * baseUrl. On the blog, which exists in English only
 * (src/lib/locale-routes.ts), every one of those links 404s. There the menu
 * lists the same locales but sends each one to its home page instead, and
 * English to the page the reader is on.
 *
 * The 404 page gets the same menu, English included: its path is by definition
 * missing, in every build. GitHub Pages serves the English 404.html for a
 * missing /fr/... URL too, and the stock menu would then offer /fr/fr/....
 * The catch-all route is the only one no plugin owns: core gives it the route
 * context "native" (core/lib/client/exports/ComponentCreator.js).
 *
 * A wrap rather than an eject: the stock component builds its URLs inside, with
 * no prop to override them, so this renders the dropdown itself on those routes
 * only, with the stock label (icon, then the current locale's name, or
 * "Languages" in the mobile drawer). Every other route gets the stock component
 * untouched. Written against @docusaurus/theme-classic 3.10.1.
 */
export default function LocaleDropdownNavbarItemWrapper(props: Props): ReactNode {
	const { pathname } = useLocation();
	const {
		i18n: { currentLocale, defaultLocale, locales, localeConfigs },
	} = useDocusaurusContext();
	const notFound = useRouteContext().plugin.name === "native";

	if (!notFound && !isEnglishOnlyPath(pathname)) return <LocaleDropdownNavbarItem {...props} />;

	const { mobile, dropdownItemsBefore, dropdownItemsAfter, queryString: _, ...rest } = props;
	const items = locales.map((locale) => {
		const config = localeConfigs[locale];
		return {
			label: config?.label,
			lang: config?.htmlLang,
			// pathname:// with autoAddBaseUrl off is how the stock dropdown gets a
			// full-page load to another build; target keeps it in this tab.
			to: `pathname://${locale === defaultLocale && !notFound ? pathname : config?.baseUrl}`,
			target: "_self",
			autoAddBaseUrl: false,
			className:
				locale !== currentLocale ? "" : mobile ? "menu__link--active" : "dropdown__link--active",
		};
	});
	const label = mobile
		? translate({
				message: "Languages",
				id: "theme.navbar.mobileLanguageDropdown.label",
				description: "The label for the mobile language switcher dropdown",
			})
		: localeConfigs[currentLocale]?.label;

	return (
		<DropdownNavbarItem
			{...rest}
			mobile={mobile}
			label={
				<>
					<IconLanguage style={{ verticalAlign: "text-bottom", marginRight: 5 }} />
					{label}
				</>
			}
			items={[...dropdownItemsBefore, ...items, ...dropdownItemsAfter]}
		/>
	);
}
