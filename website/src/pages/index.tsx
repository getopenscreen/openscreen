import Head from "@docusaurus/Head";
import Link from "@docusaurus/Link";
import Translate, { translate } from "@docusaurus/Translate";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import Heading from "@theme/Heading";
import Layout from "@theme/Layout";
import { Apple, AppWindow, ArrowDown, CircleCheck, Download, TerminalSquare } from "lucide-react";

import AppLanguages from "../components/AppLanguages";
import Editor from "../components/Editor";
import LocaleLink from "../components/LocaleLink";
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
					"OpenScreen is a free, open-source screen recorder and video editor for Windows, macOS, and Linux — native capture, on-device captions, no watermarks.",
			})}
		>
			<Head>
				{/* The product entity, distinct from the Organization/WebSite pair
				    emitted site-wide from docusaurus.config.ts. */}
				<script type="application/ld+json">
					{jsonLd(softwareApplicationLd(undefined, languages))}
				</script>
			</Head>
			<header className={styles.hero}>
				<div className={styles.heroInner}>
					{/* A link, and a claim with a baseline. "Export faster" alone said
					    faster than nothing in particular. Two platforms, not three: the
					    v1.11.0 notes give the macOS and Linux gains (#583, #559), and the
					    public benchmark, which measured 1.11.0-rc.1 against 1.10.0, agrees
					    there but has the two level on one of its Windows machines. No
					    number: the post carries the caveats a badge has no room for.
					    Short enough to stay on one line on a 375px phone, where the hero
					    already runs close to the scroll hint. */}
					<p className={styles.badgeRow}>
						<span className={styles.badgeNew}>
							<Translate id="home.hero.badge.new">NEW</Translate>
						</span>
						<LocaleLink
							className={styles.badgeText}
							to="/blog/2026/09/09/an-export-benchmark-hard-to-fake/"
						>
							<Translate
								id="home.hero.badge.text"
								description="Links to an English-only blog post. Must fit on one line on a 375px phone."
							>
								1.11 exports faster on macOS and Linux
							</Translate>
						</LocaleLink>
					</p>
					{/* The product's name, not a claim about it. The design opens on
					    "Screen Recording / Reimagined", which is the one line on a page
					    that spends its whole length proving specific things — the editor
					    runs live, the model is 264 MB, every edit is undoable — that
					    proves nothing. It also left the strongest on-page signal there is
					    without the word people search once they have heard of us.
					    The {" "} is for whatever reads the text rather than the layout:
					    without it the heading extracts as "OpenScreenA free…". */}
					<Heading as="h1" className={styles.title}>
						OpenScreen{" "}
						<span className={styles.titleTagline}>
							<Translate id="home.hero.titleTagline">
								A free, open-source screen recorder and video editor
							</Translate>
						</span>
					</Heading>
					{/* The design's "Screen Recording" line lives here, below the name:
					    it is also the query people type before they know the product.
					    Without "reimagined", for the reason the h1 comment gives. */}
					<p className={styles.tagline}>
						<Translate id="home.hero.tagline">
							Screen recording with native capture, local AI and no paywall.
						</Translate>
					</p>
					<div className={styles.actions}>
						{/* Not "Download for macOS". This page's own trio says Windows, macOS
						    and Linux, and /download offers a Store listing, a .dmg, an .exe, a
						    .deb, an .rpm, a .pacman, an AppImage and a Nix flake. The label is
						    static, so it was not adapting to the reader either: it told two of the three
						    platforms that the page's main action was not for them. */}
						<Link className={styles.primaryCta} to="/download">
							<Download size={16} />
							<Translate id="home.hero.download">Download</Translate>
						</Link>
						<Link className={styles.secondaryCta} to="/docs/intro">
							<Translate id="home.hero.readDocs">Read the docs</Translate>
						</Link>
					</div>
				</div>

				{/* An affordance, not a claim. It said "the scrollbar is the timeline",
				    which is true and is still the wrong job for this line: what a
				    reader needs at the fold is to know there is more below, and a
				    sentence is a worse signal for that than an arrow. The design pins
				    it to the bottom of the screen with a down arrow beside it, which
				    is also what makes it read as an edge rather than as a caption. */}
				<p className={styles.scrollHint}>
					<ArrowDown size={15} strokeWidth={2} />
					<Translate id="home.hero.scrollHint">Scroll down</Translate>
				</p>
			</header>

			{/* The argument, immediately after the hero. */}
			<Editor />

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
					{/* The one paragraph that says what the product is, in a form that
					    can be lifted out whole. It belongs under the hero's slogan, but
					    the hero centers its copy against a scroll hint pinned 81px from
					    its bottom edge, and four more lines run into that hint on a
					    small phone. So it leads this section instead, at body size. */}
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
