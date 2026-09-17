import Link from "@docusaurus/Link";
import Translate from "@docusaurus/Translate";
import useBaseUrl from "@docusaurus/useBaseUrl";
import type { ReactNode } from "react";

import LocaleLink from "../../components/LocaleLink";
import styles from "./styles.module.css";

const UPSTREAM_REPO_URL = "https://github.com/siddharthvaddem/openscreen";

// Shown to translators next to the blog label, the one English-only page the
// footer links. The label can say so ("Blog (English)").
const EN_ONLY = "Links to an English-only page.";

/**
 * Custom footer based on "OpenScreen Docs Site.dc.html" — a brand column
 * followed by link columns, a grid the default Docusaurus footer
 * (Links/Logo/Copyright split) can't produce, so this is a full swizzle-eject
 * rather than a themeConfig-driven layout. Being custom, it is not in the
 * footer.json that write-translations generates: its strings are <Translate>
 * ids in code.json instead.
 *
 * The design had two link columns, Project and Community. Product, Platforms
 * and Compare were added so the platform, feature and comparison pages are one
 * click from every URL on the site instead of reachable only from each other.
 * Links go through LocaleLink, which keeps the blog link working from a
 * translated build.
 */
export default function Footer(): ReactNode {
	const logoSrc = useBaseUrl("img/logo-icon.png");

	return (
		<footer className={styles.footer}>
			<div className={styles.inner}>
				<div className={styles.columns}>
					<div>
						<div className={styles.brand}>
							<img src={logoSrc} alt="" width={20} height={20} className={styles.brandLogo} />
							<span className={styles.brandName}>OpenScreen</span>
						</div>
						<p className={styles.brandDescription}>
							<Translate id="footer.brand.description">
								A free, open-source screen recorder and editor. Community-maintained continuation,
								MIT licensed.
							</Translate>
						</p>
					</div>

					<div>
						<div className={styles.colTitle}>
							<Translate id="footer.product.title">Product</Translate>
						</div>
						<div className={styles.colLinks}>
							<Link to="/download/">
								<Translate id="footer.product.download">Download</Translate>
							</Link>
							<LocaleLink to="/features/auto-zoom/">
								<Translate id="footer.product.autoZoom">Auto zoom</Translate>
							</LocaleLink>
							<LocaleLink to="/features/captions/">
								<Translate id="footer.product.captions">Local captions</Translate>
							</LocaleLink>
						</div>
					</div>

					<div>
						<div className={styles.colTitle}>
							<Translate id="footer.platforms.title" description="Footer column title.">
								Platforms
							</Translate>
						</div>
						<div className={styles.colLinks}>
							<LocaleLink to="/screen-recorder-windows/">
								<Translate id="footer.platforms.windows">Windows</Translate>
							</LocaleLink>
							<LocaleLink to="/screen-recorder-mac/">
								<Translate id="footer.platforms.mac">macOS</Translate>
							</LocaleLink>
							<LocaleLink to="/screen-recorder-linux/">
								<Translate id="footer.platforms.linux">Linux</Translate>
							</LocaleLink>
						</div>
					</div>

					<div>
						<div className={styles.colTitle}>
							<Translate id="footer.compare.title" description="Footer column title.">
								Compare
							</Translate>
						</div>
						<div className={styles.colLinks}>
							<LocaleLink to="/alternatives/screen-studio/">
								<Translate id="footer.compare.screenStudio">Screen Studio alternative</Translate>
							</LocaleLink>
							<LocaleLink to="/alternatives/camtasia/">
								<Translate id="footer.compare.camtasia">Camtasia alternative</Translate>
							</LocaleLink>
							<LocaleLink to="/alternatives/loom/">
								<Translate id="footer.compare.loom">Loom alternative</Translate>
							</LocaleLink>
							<LocaleLink to="/compare/openscreen-vs-cap/">
								<Translate id="footer.compare.cap">OpenScreen vs Cap</Translate>
							</LocaleLink>
							<LocaleLink to="/compare/openscreen-vs-obs/">
								<Translate id="footer.compare.obs">OpenScreen vs OBS Studio</Translate>
							</LocaleLink>
						</div>
					</div>

					<div>
						<div className={styles.colTitle}>
							<Translate id="footer.project.title">Project</Translate>
						</div>
						<div className={styles.colLinks}>
							<Link href="https://github.com/getopenscreen/openscreen">GitHub</Link>
							<Link href="https://github.com/getopenscreen/openscreen/releases">
								<Translate id="footer.project.releases">Releases</Translate>
							</Link>
							<LocaleLink to="/blog/">
								<Translate id="footer.project.blog" description={EN_ONLY}>
									Blog
								</Translate>
							</LocaleLink>
							<Link to="/docs/faq/">
								<Translate id="footer.project.faq">FAQ</Translate>
							</Link>
						</div>
					</div>

					<div>
						<div className={styles.colTitle}>
							<Translate id="footer.community.title">Community</Translate>
						</div>
						<div className={styles.colLinks}>
							<Link href="https://github.com/getopenscreen/openscreen/blob/main/CONTRIBUTING.md">
								<Translate id="footer.community.contributing">Contributing</Translate>
							</Link>
							<Link href="https://github.com/getopenscreen/openscreen/blob/main/LICENSE">
								<Translate id="footer.community.license">License (MIT)</Translate>
							</Link>
							<Link href="https://getopenscreen.com/discord/">Discord</Link>
						</div>
					</div>
				</div>

				<div className={styles.bottomBar}>
					<p>
						<Translate id="footer.bottom.license">
							OpenScreen is released under the MIT license. Built by the community — free, forever.
						</Translate>
					</p>
					{/* Lineage, stated once and in prose: this fork inherits the name, so
					    the relationship to the archived original belongs somewhere on
					    every page. Also stated as schema.org isBasedOn on the product entity. */}
					<p>
						<Translate
							id="footer.bottom.lineage"
							values={{
								originalProject: (
									<Link className={styles.lineageLink} href={UPSTREAM_REPO_URL}>
										<Translate id="footer.bottom.lineage.originalProject">
											original OpenScreen project
										</Translate>
									</Link>
								),
							}}
						>
							{"The official spin-off of the {originalProject} — 39k stars, now archived."}
						</Translate>
					</p>
				</div>
			</div>
		</footer>
	);
}
