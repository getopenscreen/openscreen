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
