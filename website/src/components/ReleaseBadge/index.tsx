import Translate, { translate } from "@docusaurus/Translate";
import { ArrowRight } from "lucide-react";

import LocaleLink from "../LocaleLink";
import styles from "./styles.module.css";

export default function ReleaseBadge() {
	return (
		<LocaleLink
			className={styles.badge}
			to="/blog/2026/09/27/making-of-v2-a-demo-is-never-ugly/"
			title={translate({
				id: "announcement.v2.link",
				message: "See what's new",
				description: "Links to an English-only blog post. Mention English in translated labels.",
			})}
			data-release-announcement=""
		>
			<span className={styles.dot} aria-hidden="true" />
			<Translate id="announcement.v2.title">OpenScreen v2 is here</Translate>
			<ArrowRight size={14} aria-hidden="true" />
		</LocaleLink>
	);
}

// The launch's Product Hunt rank, in the same pill. Product Hunt's own embed is a white
// 250x54 card that outshone the download button beside it. The fill is Product Hunt's
// brand colour: the mark is theirs, not a theme colour.
export function ProductHuntBadge() {
	return (
		<a
			className={styles.badge}
			href="https://www.producthunt.com/products/openscreen-2"
			target="_blank"
			rel="noopener"
		>
			<svg width="15" height="15" viewBox="0 0 24 24" fill="#DA552F" aria-hidden="true">
				<path d="M13.604 8.4h-3.405V12h3.405c.995 0 1.801-.806 1.801-1.801 0-.993-.805-1.799-1.801-1.799zM12 0C5.372 0 0 5.372 0 12s5.372 12 12 12 12-5.372 12-12S18.628 0 12 0zm1.604 14.4h-3.405V18H7.801V6h5.804c2.319 0 4.2 1.88 4.2 4.199 0 2.321-1.881 4.201-4.201 4.201z" />
			</svg>
			<Translate
				id="announcement.productHunt.rank"
				description="The launch's rank on Product Hunt (October 11, 2026). Keep the #5."
			>
				#5 Product of the Day
			</Translate>
		</a>
	);
}
