import Head from "@docusaurus/Head";
import Link from "@docusaurus/Link";
import Translate, { translate } from "@docusaurus/Translate";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import Heading from "@theme/Heading";
import Layout from "@theme/Layout";
import { Apple, AppWindow, CircleCheck, TerminalSquare } from "lucide-react";

import AppLanguages from "../components/AppLanguages";
import Editor from "../components/Editor";
import Films from "../components/Films";
import LocaleLink from "../components/LocaleLink";
import PlatformDownload from "../components/PlatformDownload";
import ReleaseBadge from "../components/ReleaseBadge";
import Showcase from "../components/Showcase";
import type { AppLanguage } from "../lib/release";
import { jsonLd, softwareApplicationLd } from "../lib/structured-data";
import styles from "./index.module.css";

export default function Home() {
	const { siteConfig } = useDocusaurusContext();
	const languages = (siteConfig.customFields?.appLanguages ?? []) as AppLanguage[];

	return (
		<Layout
			title={translate({
				id: "home.meta.title",
				message: "Free open-source screen recorder & video editor",
			})}
			description={translate({
				id: "home.meta.description",
				message:
					"Turn screen recordings into polished demos with automatic zooms, styled backgrounds and an editable cursor. Free and open source for Windows, macOS and Linux. No watermark.",
			})}
		>
			<Head>
				{/* The product entity, distinct from the Organization/WebSite pair
				    emitted site-wide from docusaurus.config.ts. */}
				<script type="application/ld+json">
					{jsonLd(softwareApplicationLd(undefined, languages))}
				</script>
			</Head>
			<header className={styles.hero} data-home-hero="">
				<div className={styles.heroInner}>
					<div className={styles.heroCopy}>
						<ReleaseBadge />
						<Heading as="h1" className={styles.title}>
							<Translate id="home.hero.title">Great demos on the first take.</Translate>
						</Heading>
						<p className={styles.tagline}>
							<Translate id="home.hero.tagline">
								Automatic zooms, smooth cursor movement, and a frame that looks finished. Record,
								adjust, share.
							</Translate>
						</p>
						<div className={styles.actions}>
							<PlatformDownload className={styles.primaryCta} />
						</div>
						<p className={styles.reassurance}>
							<Translate id="home.hero.reassurance">
								Free and open source. No watermark. No account.
							</Translate>
						</p>
						<p className={styles.platforms}>
							<Translate id="home.features.platforms.title">Windows, macOS, Linux</Translate>
						</p>
					</div>
				</div>
			</header>

			{/* The same live picture loops here, then docks into its editor. */}
			<Editor />

			{/* What the editor above does not reach, filmed from the app. */}
			<Films />

			{/* The claims the editor cannot make on its own. */}
			<Showcase />

			<section className={styles.features}>
				<div className={styles.featuresInner}>
					<div className={styles.sectionKicker}>
						<Translate id="home.features.kicker">Also true</Translate>
					</div>
					{/* Capabilities are the section above; these three are properties,
					    and no screenshot of the application can establish any of them —
					    which is why they get one repeated tick instead of three
					    illustrations pretending to show something. The heading names
					    the three before it says so: the old line alone carried none of
					    the words anyone searches with. */}
					<Heading as="h2" className={styles.sectionTitle}>
						<Translate id="home.features.title">
							Free, local, cross-platform: three things a screenshot can't show.
						</Translate>
					</Heading>
					{/* The product's definition and project history, after the demonstrations. */}
					<p className={styles.productSummary}>
						<Translate
							id="home.features.summary"
							description="{screenStudio} is a link to the Screen Studio comparison page."
							values={{
								screenStudio: (
									<LocaleLink to="/alternatives/screen-studio/">
										<Translate
											id="home.features.summary.screenStudio"
											description="A product name, used as a link."
										>
											Screen Studio
										</Translate>
									</LocaleLink>
								),
								originalProject: (
									<a href="https://github.com/siddharthvaddem/openscreen">
										<Translate id="home.features.summary.originalProject">
											original OpenScreen project
										</Translate>
									</a>
								),
							}}
						>
							{
								"OpenScreen is a free, open-source screen recorder and video editor for Windows, macOS, and Linux: a raw capture goes in and a finished demo comes out, in the category {screenStudio} defined. It is MIT licensed, with no watermark and no account, and it continues the {originalProject}, which its creator archived after v1.5.0."
							}
						</Translate>
					</p>

					<div className={styles.trio}>
						<article className={styles.trioItem}>
							<CircleCheck className={styles.trioTick} size={21} />
							<h3>
								<Translate id="home.features.free.title">MIT, free forever</Translate>
							</h3>
							<p>
								<Translate id="home.features.free.body">
									No paywalls, no premium tier, no usage caps. Every feature ships free for personal
									and commercial use.
								</Translate>
							</p>
						</article>

						<article className={styles.trioItem}>
							<CircleCheck className={styles.trioTick} size={21} />
							<h3>
								<Translate id="home.features.local.title">Nothing is uploaded</Translate>
							</h3>
							<p>
								<Translate id="home.features.local.body">
									Recording, transcription and rendering all happen on your machine, and your video
									never leaves it. Text leaves only when you ask: the chat panel and caption
									translation, each with a key you supply. Transcription downloads its 264 MB
									Whisper model once, on first run.
								</Translate>
							</p>
						</article>

						<article className={styles.trioItem}>
							<CircleCheck className={styles.trioTick} size={21} />
							<h3>
								<Translate id="home.features.platforms.title">Windows, macOS, Linux</Translate>
							</h3>
							<p>
								<Translate id="home.features.platforms.body">
									One source tree, native capture on each. A Microsoft Store listing, a .dmg, an
									.exe, a .deb, a .rpm, a .pacman, an AppImage and a Nix flake.
								</Translate>
							</p>
						</article>
					</div>

					{/* A property too, and the first one a reader who does not read
					    English looks for. Generated from the release the site serves. */}
					<AppLanguages className={styles.appLanguages} />
				</div>
			</section>

			<section className={styles.quickStart} id="download-install">
				<div className={styles.quickStartInner}>
					<div className={styles.sectionKicker}>
						<Translate id="home.install.kicker">Quick start</Translate>
					</div>
					<Heading as="h2" className={styles.sectionTitle}>
						<Translate id="home.install.title">Download and install</Translate>
					</Heading>

					{/* One pane per platform, same chrome and same weight. An earlier
					    version showed only the Linux command with the other two in a
					    footnote, which read at a glance as "Linux only".

					    Each pane shows the route the README recommends. macOS lost its
					    `xattr` line: builds from 1.9.0 are signed and notarized, so the
					    command answered a Gatekeeper block that no longer happens.
					    Windows shows the Store's winget line rather than the .exe, which
					    is unsigned and so is not "double-click and go" — SmartScreen
					    stops it first, as the note below says.

					    The footers say what each platform records, from the platform
					    table in docs/installation.md: the webcam is native on Windows
					    only, and Linux captures natively through PipeWire. */}
					<div className={styles.installGrid}>
						<div className={styles.terminal}>
							<div className={styles.terminalHeader}>
								<Apple size={14} />
								<span>macOS</span>
								<span className={styles.artifactChip}>.dmg</span>
							</div>
							<pre className={styles.terminalBody}>
								<span className={styles.meta}>
									<Translate id="home.install.mac.comment">{"# open the .dmg, then"}</Translate>
								</span>
								{"\n"}
								<span className={styles.plainAction}>
									<Translate id="home.install.mac.action">
										Drag OpenScreen to Applications.
									</Translate>
								</span>
							</pre>
							<p className={styles.paneFoot}>
								<Translate id="home.install.mac.foot">
									Signed and notarized. ScreenCaptureKit capture; cursor shape and clicks once
									Accessibility is granted.
								</Translate>
							</p>
						</div>

						<div className={styles.terminal}>
							<div className={styles.terminalHeader}>
								<AppWindow size={14} />
								<span>Windows</span>
								<span className={styles.artifactChip}>Store</span>
							</div>
							<pre className={styles.terminalBody}>
								<span className={styles.meta}>
									<Translate id="home.install.windows.comment">
										{"# Microsoft Store, from a terminal"}
									</Translate>
								</span>
								{"\n"}
								<span className={styles.accentText}>winget</span> install --source msstore
								OpenScreen
							</pre>
							<p className={styles.paneFoot}>
								<Translate id="home.install.windows.foot">
									Windows Graphics Capture, system audio out of the box, Media Foundation webcam
									capture.
								</Translate>
							</p>
						</div>

						<div className={styles.terminal}>
							<div className={styles.terminalHeader}>
								<TerminalSquare size={14} />
								<span>Linux</span>
								<span className={styles.artifactChip}>.deb</span>
							</div>
							<pre className={styles.terminalBody}>
								<span className={styles.meta}>
									<Translate id="home.install.linux.comment">
										{"# download the .deb from Releases, then"}
									</Translate>
								</span>
								{"\n"}
								<span className={styles.accentText}>sudo</span> apt install ./Openscreen-Linux-*.deb
							</pre>
							<p className={styles.paneFoot}>
								<Translate id="home.install.linux.foot">
									PipeWire capture through the ScreenCast portal; needs PipeWire and
									xdg-desktop-portal.
								</Translate>
							</p>
						</div>
					</div>

					<p className={styles.quickStartNote}>
						<Translate
							id="home.install.note"
							description="{exe}, {rpm} and {pacman} are file extensions shown as code. {windows}, {mac} and {linux} link to the platform pages. More info and Run anyway are SmartScreen's buttons: use the labels Windows shows in your language."
							values={{
								exe: <code>.exe</code>,
								rpm: <code>.rpm</code>,
								pacman: <code>.pacman</code>,
								releasesPage: (
									<a href="https://github.com/getopenscreen/openscreen/releases">
										<Translate id="home.install.note.releasesPage">Releases page</Translate>
									</a>
								),
								installation: (
									<Link to="/docs/installation">
										<Translate id="home.install.note.installation">Installation</Translate>
									</Link>
								),
								windows: (
									<LocaleLink to="/screen-recorder-windows/">
										<Translate id="home.install.note.windows">Windows</Translate>
									</LocaleLink>
								),
								mac: (
									<LocaleLink to="/screen-recorder-mac/">
										<Translate id="home.install.note.mac">Mac</Translate>
									</LocaleLink>
								),
								linux: (
									<LocaleLink to="/screen-recorder-linux/">
										<Translate id="home.install.note.linux">Linux</Translate>
									</LocaleLink>
								),
							}}
						>
							{
								"Windows also has an {exe} installer. It is not code-signed, so SmartScreen warns before it runs: choose More info, then Run anyway. Linux also ships {rpm}, {pacman}, an AppImage, and a Nix flake. Every artifact is on the {releasesPage}, and {installation} has the full steps. What each system records is covered on the {windows}, {mac} and {linux} pages."
							}
						</Translate>
					</p>
				</div>
			</section>
		</Layout>
	);
}
