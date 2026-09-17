import Head from "@docusaurus/Head";
import Link from "@docusaurus/Link";
import Translate, { translate } from "@docusaurus/Translate";
import useBaseUrl from "@docusaurus/useBaseUrl";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import Heading from "@theme/Heading";
import Layout from "@theme/Layout";
import {
	Apple,
	AppWindow,
	Download,
	ExternalLink,
	FlaskConical,
	TerminalSquare,
} from "lucide-react";
import type { ReactNode } from "react";

import AppLanguages from "../components/AppLanguages";
import { type AppLanguage, type AssetKind, findAsset, type LatestRelease } from "../lib/release";
import { jsonLd, SOFTWARE_ID, softwareApplicationLd, WEBSITE_ID } from "../lib/structured-data";
import styles from "./download.module.css";

const REPO_URL = "https://github.com/getopenscreen/openscreen";
const RELEASES_URL = `${REPO_URL}/releases`;
const LATEST_URL = `${RELEASES_URL}/latest`;
// The listing README.md recommends on Windows, and the ID in its winget command.
const STORE_URL = "https://apps.microsoft.com/detail/9MXQ1HQJL5G5";

type PlatformSpec = {
	id: string;
	name: string;
	icon: typeof Apple;
	/** One row per way the platform actually ships: a release asset, resolved at
	 *  build time, or a fixed `href` for a channel that is not a file. */
	options: ({ label: string; sublabel: string } & (
		| { kind: AssetKind; href?: never }
		| { kind?: never; href: string }
	))[];
	footnote?: ReactNode;
};

/** Built at render, because translate() answers in the locale being rendered. */
function getPlatforms(): PlatformSpec[] {
	return [
		{
			id: "macos",
			name: "macOS",
			icon: Apple,
			options: [
				{
					kind: "macArm",
					label: translate({ id: "download.macos.arm.label", message: "Apple Silicon" }),
					sublabel: translate({
						id: "download.macos.arm.sublabel",
						message: "M1 and newer · .dmg",
					}),
				},
				{
					kind: "macIntel",
					label: translate({ id: "download.macos.intel.label", message: "Intel" }),
					sublabel: translate({ id: "download.macos.intel.sublabel", message: "x86_64 · .dmg" }),
				},
			],
			// No Gatekeeper workaround any more: builds from 1.9.0 on are signed with a
			// Developer ID and notarized (README.md), so the `xattr` panel this page
			// used to carry answered a block that no longer happens.
			footnote: translate({
				id: "download.macos.footnote",
				message:
					"Signed and notarized, so it opens with no terminal step. Grant Screen Recording and Accessibility on first launch.",
				description:
					"Screen Recording and Accessibility are macOS privacy settings: use the names macOS shows in your language.",
			}),
		},
		{
			id: "windows",
			name: "Windows",
			icon: AppWindow,
			// The Store first because README.md recommends it: Microsoft signs that
			// package, and it updates itself. The .exe stays for machines without the
			// Store, and it is unsigned, which the winget panel below spells out.
			options: [
				{
					href: STORE_URL,
					label: translate({ id: "download.windows.store.label", message: "Microsoft Store" }),
					sublabel: translate({
						id: "download.windows.store.sublabel",
						message: "Recommended · signed by Microsoft",
					}),
				},
				{
					kind: "windows",
					label: translate({ id: "download.windows.exe.label", message: "Windows 10 & 11" }),
					sublabel: translate({
						id: "download.windows.exe.sublabel",
						message: "Installer · .exe · unsigned",
					}),
				},
			],
			footnote: (
				<Translate
					id="download.windows.footnote"
					values={{
						systemRequirements: (
							<Link to="/docs/installation#system-requirements">
								<Translate id="download.windows.footnote.systemRequirements">
									system requirements
								</Translate>
							</Link>
						),
					}}
				>
					{
						"System audio is captured without extra drivers. Integrated graphics older than ~8th-gen Intel (or the AMD Ryzen 2000 series equivalent) may hit known recording-stop issues — see {systemRequirements}."
					}
				</Translate>
			),
		},
		{
			id: "linux",
			name: "Linux",
			icon: TerminalSquare,
			options: [
				{
					kind: "deb",
					label: "Debian, Ubuntu, Pop!_OS",
					sublabel: translate({ id: "download.linux.deb.sublabel", message: "Package · .deb" }),
				},
				{
					kind: "rpm",
					label: "Fedora, RHEL, CentOS",
					sublabel: translate({ id: "download.linux.rpm.sublabel", message: "Package · .rpm" }),
				},
				{
					kind: "pacman",
					label: "Arch, Manjaro",
					sublabel: translate({
						id: "download.linux.pacman.sublabel",
						message: "Package · .pacman",
					}),
				},
				{
					kind: "appImage",
					label: translate({ id: "download.linux.appImage.label", message: "Any distribution" }),
					sublabel: translate({
						id: "download.linux.appImage.sublabel",
						message: "Portable · .AppImage",
					}),
				},
			],
			footnote: translate({
				id: "download.linux.footnote",
				message: "Capture goes through PipeWire and xdg-desktop-portal; both are required.",
			}),
		},
	];
}

/**
 * Hooks this URL onto the site's entity graph: a WebPage node that is part of
 * the site-wide WebSite and whose subject is the product entity, plus that
 * entity itself under its canonical @id. Emitting the SoftwareApplication here
 * as well as on the landing page is not duplication — the shared @id makes both
 * copies one entity — and it is what lets this page, the one we want ranking for
 * "openscreen download", carry the app's category, platforms, price, and version.
 *
 * The WebPage node is this locale's page: its own URL, language, title and
 * description, the last two shared with <Layout> so the two cannot drift (a
 * structured-data description that contradicts the meta one is worse than none).
 */
function downloadPageLd(
	page: { url: string; title: string; description: string; inLanguage: string },
	release: LatestRelease,
	languages: AppLanguage[],
): string {
	return jsonLd(
		{
			"@type": "WebPage",
			"@id": `${page.url}#webpage`,
			url: page.url,
			name: page.title,
			description: page.description,
			inLanguage: page.inLanguage,
			isPartOf: { "@id": WEBSITE_ID },
			about: { "@id": SOFTWARE_ID },
			mainEntity: { "@id": SOFTWARE_ID },
		},
		softwareApplicationLd(release, languages),
	);
}

export default function DownloadPage() {
	const { siteConfig, i18n } = useDocusaurusContext();
	const release = (siteConfig.customFields?.latestRelease ?? null) as LatestRelease;
	const languages = (siteConfig.customFields?.appLanguages ?? []) as AppLanguage[];
	const page = {
		url: `${siteConfig.url}${useBaseUrl("/download/")}`,
		title: translate({
			id: "download.meta.title",
			message: "Download for Windows, macOS & Linux",
		}),
		description: translate({
			id: "download.meta.description",
			message:
				"Download OpenScreen free for Windows, macOS, and Linux: Microsoft Store, .exe, .dmg, .deb, .rpm, .pacman, AppImage, Nix flake. Open source, no account.",
		}),
		inLanguage: i18n.localeConfigs[i18n.currentLocale]?.htmlLang ?? i18n.currentLocale,
	};

	return (
		<Layout title={page.title} description={page.description}>
			<Head>
				<script type="application/ld+json">{downloadPageLd(page, release, languages)}</script>
			</Head>
			<header className={styles.hero}>
				<div className={styles.heroInner}>
					<span className={styles.badge}>
						{release
							? translate(
									{
										id: "download.hero.badge.release",
										message: "{tag} · MIT licensed",
										description: "{tag} is the release tag, e.g. v1.11.0",
									},
									{ tag: release.tag },
								)
							: translate({
									id: "download.hero.badge.noRelease",
									message: "MIT licensed · free forever",
								})}
					</span>
					<Heading as="h1" className={styles.title}>
						<Translate id="download.hero.title">Download OpenScreen</Translate>
					</Heading>
					<p className={styles.tagline}>
						<Translate id="download.hero.tagline">
							A free, open-source screen recorder and video editor. No account, no watermark, no
							subscription.
						</Translate>
					</p>
					{release?.published ? (
						<p className={styles.releaseMeta}>
							<Translate
								id="download.hero.published"
								description="{date} is formatted for your language at build time"
								values={{ date: release.published }}
							>
								{"Latest stable release, published {date}"}
							</Translate>
						</p>
					) : null}
					<AppLanguages className={styles.appLanguages} />
				</div>
			</header>

			<section className={styles.platforms}>
				<div className={styles.platformsInner}>
					<div className={styles.grid}>
						{getPlatforms().map(({ id, name, icon: Icon, options, footnote }) => (
							<article key={id} className={styles.card}>
								<div className={styles.cardHeader}>
									<Icon size={15} />
									<span>{name}</span>
								</div>
								<div className={styles.cardBody}>
									{options.map(({ kind, href, label, sublabel }) => {
										const asset = kind ? findAsset(release, kind) : null;
										// No build-time asset data (rate-limited runner) degrades
										// to the releases list rather than rendering a dead link.
										// A renamed artifact does not: the build fails on it.
										// The unit is translated: French writes Mo.
										const size = asset?.size
											? translate(
													{
														id: "download.option.size",
														message: "{size} MB",
														description:
															"{size} is a whole number of megabytes. Use your language's unit symbol (Mo in French).",
													},
													{ size: Math.round(asset.size / 1048576) },
												)
											: "";
										// A set href is a listing (the Store), not a file.
										const OptionIcon = href ? ExternalLink : Download;
										return (
											<a
												key={kind ?? href}
												className={styles.option}
												href={href ?? asset?.url ?? LATEST_URL}
											>
												<span className={styles.optionText}>
													<span className={styles.optionLabel}>{label}</span>
													<span className={styles.optionSub}>{sublabel}</span>
												</span>
												{size ? <span className={styles.optionSize}>{size}</span> : null}
												<OptionIcon size={14} className={styles.optionIcon} />
											</a>
										);
									})}
								</div>
								{footnote ? <p className={styles.cardFoot}>{footnote}</p> : null}
							</article>
						))}
					</div>

					<div className={styles.panels}>
						<div className={styles.panel}>
							<div className={styles.panelHeader}>
								<AppWindow size={14} />
								<span>
									<Translate id="download.panels.winget.title">
										Windows: the Store build from a terminal
									</Translate>
								</span>
							</div>
							<pre className={styles.code}>
								<span className={styles.accentText}>winget</span> install --source msstore
								OpenScreen
							</pre>
							<p className={styles.panelFoot}>
								<Translate
									id="download.panels.winget.foot"
									description="Windows protected your PC, More info and Run anyway are SmartScreen's own words: use the ones Windows shows in your language."
									values={{
										releasesPage: (
											<a href={LATEST_URL}>
												<Translate id="download.panels.winget.foot.releasesPage">
													Releases page
												</Translate>
											</a>
										),
									}}
								>
									{
										"The .exe is not code-signed, so SmartScreen shows “Windows protected your PC”: choose More info, then Run anyway. Download it only from the {releasesPage}."
									}
								</Translate>
							</p>
						</div>

						<div className={styles.panel}>
							<div className={styles.panelHeader}>
								<TerminalSquare size={14} />
								<span>
									<Translate id="download.panels.nix.title">
										Nix: run it without installing
									</Translate>
								</span>
							</div>
							<pre className={styles.code}>
								<span className={styles.accentText}>nix</span> run github:getopenscreen/openscreen
							</pre>
							<p className={styles.panelFoot}>
								<Translate
									id="download.panels.nix.foot"
									values={{
										installationGuide: (
											<Link to="/docs/installation">
												<Translate id="download.panels.nix.foot.installationGuide">
													installation guide
												</Translate>
											</Link>
										),
									}}
								>
									{"Per-distribution steps are in the {installationGuide}."}
								</Translate>
							</p>
						</div>
					</div>

					{/* Release candidates ship between stable versions and are genuinely
					    ahead of what the cards above serve, so this is a real path and not
					    a footer link — kept visually quiet so it cannot be mistaken for
					    the recommended download. */}
					<aside className={styles.preRelease}>
						<FlaskConical size={16} className={styles.preReleaseIcon} />
						<div className={styles.preReleaseText}>
							<p className={styles.preReleaseTitle}>
								<Translate id="download.preRelease.title">
									Want to test what is coming next?
								</Translate>
							</p>
							<p className={styles.preReleaseBody}>
								<Translate id="download.preRelease.body">
									Release candidates ship between stable versions, alongside older releases,
									checksums, and full release notes.
								</Translate>
							</p>
						</div>
						<a className={styles.preReleaseCta} href={RELEASES_URL}>
							<Translate id="download.preRelease.cta">Browse all releases</Translate>
						</a>
					</aside>
				</div>
			</section>
		</Layout>
	);
}
