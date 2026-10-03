import Translate from "@docusaurus/Translate";
import { ArrowRight } from "lucide-react";

import LocaleLink from "../../components/LocaleLink";
import styles from "./styles.module.css";

// Layout renders this above the navbar, including on translated pages.
export default function AnnouncementBar() {
	return (
		<div className={styles.bar} data-release-announcement="">
			<LocaleLink className={styles.link} to="/blog/2026/09/27/making-of-v2-a-demo-is-never-ugly/">
				<span className={styles.version}>V2</span>
				<span className={styles.content}>
					<span className={styles.title}>
						<Translate id="announcement.v2.title">OpenScreen v2 is on its way</Translate>
					</span>
					<span className={styles.cta}>
						<Translate
							id="announcement.v2.link"
							description="Links to an English-only blog post. Mention English in translated labels."
						>
							See what's coming
						</Translate>
						<ArrowRight size={14} aria-hidden="true" />
					</span>
				</span>
			</LocaleLink>
		</div>
	);
}
