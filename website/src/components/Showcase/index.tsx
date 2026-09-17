/**
 * What the app is besides the editor: the recorder in front of it, the encoder
 * behind it, and the two features that are easier to show than to describe.
 *
 * Four claims, four drawn panels, alternating sides. Nothing here plays: the
 * page has one moving thing on it and it is the editor above, which is the
 * point of having built it.
 *
 * The copy is first in the DOM in every band, including the two that draw the
 * panel on the left — the sides are swapped by grid placement, so which way a
 * band faces is a layout decision and never a reading-order one.
 *
 * Each band's copy links to the docs page behind its claim, and to the feature
 * page where there is one, just above the specification line. The landing
 * page used to link only to the docs' front door, which left the pages that
 * back these claims one navigation further from the page that makes them.
 */

import Translate from "@docusaurus/Translate";
import Heading from "@theme/Heading";
import { Fragment } from "react";

import LocaleLink from "../LocaleLink";
import { getFeatures } from "./content";
import { PANELS } from "./panels";
import styles from "./styles.module.css";

export default function Showcase() {
	return (
		<section className={styles.section} aria-labelledby="showcase-title">
			<div className={styles.inner}>
				<Heading as="h2" id="showcase-title" className={styles.title}>
					<Translate id="showcase.title">Recorder, captions, agent, encoder.</Translate>
				</Heading>

				{getFeatures().map((item) => (
					<article
						key={item.id}
						id={item.id}
						data-band={item.id}
						className={`${styles.band} ${item.flip ? styles.flip : ""}`}
					>
						<div className={styles.copy}>
							<p className={styles.itemKicker}>{item.kicker}</p>
							<h3 className={styles.claim}>{item.claim}</h3>
							<p className={styles.body}>{item.body}</p>
							<p className={styles.body}>
								{item.links.map((link, i) => (
									<Fragment key={link.to}>
										{i > 0 && " · "}
										<LocaleLink to={link.to}>{link.label}</LocaleLink>
									</Fragment>
								))}
							</p>
							<p className={styles.fact}>{item.fact}</p>
						</div>

						{/* One label for the whole drawing. Without it a screen reader walks
						    two dozen interface fragments — "Display 1", "60 fps", "62%" —
						    that mean nothing out of the picture they are drawn in.
						    The drawing is in English on every locale, so it says so; the
						    figure does not, its label is translated. */}
						<figure className={styles.figure} role="img" aria-label={item.label}>
							<span className={styles.glow} />
							<div lang="en">{PANELS[item.id]}</div>
						</figure>
					</article>
				))}
			</div>
		</section>
	);
}
