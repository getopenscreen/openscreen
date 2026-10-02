/**
 * Films of the app, under the editor: a centred head, a wide stage, and the
 * notes that say what the film just showed.
 *
 * A stage with several loops plays them in turn. Each plays once, its tab
 * filling as it goes, then hands over to the next; a click on a tab jumps
 * there. Everything about loading and playback (nothing fetched before the
 * stage is near, 720p or 1080p from the real width, pause off screen, no
 * autoplay under reduced motion, a pause button) is DemoLoop's.
 */

import { translate } from "@docusaurus/Translate";
import Heading from "@theme/Heading";
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";

import DemoLoop, { LoopSchema } from "../DemoLoop";
import { type Block, getBlocks, getPair } from "./content";
import styles from "./styles.module.css";

function Stage({ block }: { block: Block }) {
	const [index, setIndex] = useState(0);
	// The loop being left, kept on top while the next one loads, then faded out.
	const [prev, setPrev] = useState<number | null>(null);
	const [fading, setFading] = useState(false);
	const bars = useRef<(HTMLSpanElement | null)[]>([]);
	const tabs = useRef<(HTMLButtonElement | null)[]>([]);
	const panel = useRef<HTMLDivElement>(null);
	const tablist = useRef<HTMLDivElement>(null);
	const many = block.tabs.length > 1;

	// Straight to the DOM: a state update per frame would re-render the block.
	const onProgress = useCallback(
		(p: number) => bars.current[index]?.style.setProperty("--p", String(p)),
		[index],
	);
	const go = (i: number) => {
		if (i === index) return;
		bars.current.forEach((el) => el?.style.setProperty("--p", "0"));
		setPrev(index);
		setFading(false);
		setIndex(i);
	};

	// A clip that ends hands over to the next. If focus was inside it (its pause
	// button, which is about to fade out and unmount), it moves to the tab now
	// selected rather than falling back to the page.
	const advance = () => {
		const next = (index + 1) % block.tabs.length;
		// On a tab too: the selection moves, so the one Tab stop moves with it.
		const hadFocus =
			(panel.current?.contains(document.activeElement) ||
				tablist.current?.contains(document.activeElement)) ??
			false;
		go(next);
		if (hadFocus) requestAnimationFrame(() => tabs.current[next]?.focus());
	};

	// The WAI-ARIA tabs pattern: one Tab stop for the whole list (the selected
	// tab), arrows and Home/End to move, selection following focus.
	const onKeyDown = (e: KeyboardEvent) => {
		const n = block.tabs.length;
		const to =
			e.key === "ArrowRight"
				? (index + 1) % n
				: e.key === "ArrowLeft"
					? (index - 1 + n) % n
					: e.key === "Home"
						? 0
						: e.key === "End"
							? n - 1
							: null;
		if (to === null) return;
		e.preventDefault();
		go(to);
		tabs.current[to]?.focus();
	};

	// Without a first frame (reduced motion fetches nothing until play), fade anyway.
	useEffect(() => {
		if (prev === null) return;
		const t = window.setTimeout(() => setFading(true), 900);
		return () => window.clearTimeout(t);
	}, [prev]);

	// Drop the outgoing layer once its fade (0.6 s in the CSS) is over. A timer,
	// not transitionend: the layer's descendants transition too, and an event
	// from any of them ended the fade early.
	// Focus left inside it (a pause button) would fall back to the page with
	// it, so it moves to the selected tab first.
	useEffect(() => {
		if (!fading || prev === null) return;
		const t = window.setTimeout(() => {
			const out = panel.current?.querySelector("[data-outgoing]");
			if (out?.contains(document.activeElement)) tabs.current[index]?.focus();
			setPrev(null);
		}, 700);
		return () => window.clearTimeout(t);
	}, [fading, prev, index]);

	// Both layers are keyed by their loop, so the outgoing one keeps its last
	// frame instead of remounting from the start.
	const layers = [
		...(prev !== null && prev !== index ? [{ i: prev, out: true }] : []),
		{ i: index, out: false },
	];

	return (
		<div className={styles.stage}>
			{/* Every tab's loop is on the page, one click away: declare them all. */}
			<LoopSchema names={block.tabs.map((t) => t.loop)} />
			<span className={styles.glow} />
			{many && (
				<div
					ref={tablist}
					className={styles.tabs}
					role="tablist"
					aria-label={block.title}
					onKeyDown={onKeyDown}
				>
					{block.tabs.map((tab, i) => (
						<button
							key={tab.loop}
							type="button"
							role="tab"
							id={`${block.id}-tab-${i}`}
							aria-selected={i === index}
							aria-controls={`${block.id}-panel`}
							tabIndex={i === index ? 0 : -1}
							ref={(el) => {
								tabs.current[i] = el;
							}}
							className={styles.tab}
							onClick={() => go(i)}
						>
							{tab.label}
							<span
								ref={(el) => {
									bars.current[i] = el;
								}}
								className={styles.tabProgress}
								aria-hidden="true"
							/>
						</button>
					))}
				</div>
			)}
			<div
				ref={panel}
				className={`${styles.frame} ${styles.layers}`}
				id={`${block.id}-panel`}
				role={many ? "tabpanel" : undefined}
				aria-labelledby={many ? `${block.id}-tab-${index}` : undefined}
			>
				{layers.map(({ i, out }) => (
					<div
						key={block.tabs[i].loop}
						className={`${styles.layer} ${out ? styles.outgoing : ""} ${out && fading ? styles.gone : ""}`}
						aria-hidden={out || undefined}
						data-outgoing={out || undefined}
					>
						<DemoLoop
							name={block.tabs[i].loop}
							schema={false}
							loop={!many}
							onProgress={!out && many ? onProgress : undefined}
							onEnded={!out && many ? advance : undefined}
							onReady={!out ? () => setFading(true) : undefined}
						/>
					</div>
				))}
			</div>
		</div>
	);
}

export default function Films() {
	const pair = getPair();
	return (
		<section
			className={styles.section}
			aria-label={translate({
				id: "films.label",
				description: "Read by screen readers only: names the section of feature videos",
				message: "More of the app, in motion",
			})}
		>
			<div className={styles.inner}>
				{getBlocks().map((block) => (
					<article key={block.id} id={block.id} className={styles.block}>
						<header className={styles.head}>
							<p className={styles.kicker}>{block.kicker}</p>
							<Heading as="h2" className={styles.title}>
								{block.title}
							</Heading>
							<p className={styles.lead}>{block.lead}</p>
						</header>
						<Stage block={block} />
						<ul className={styles.notes}>
							{block.notes.map((note, i) => (
								<li key={i} className={styles.note}>
									{note}
								</li>
							))}
						</ul>
					</article>
				))}

				<article id={pair.id} className={styles.block}>
					<header className={styles.head}>
						<p className={styles.kicker}>{pair.kicker}</p>
						<Heading as="h2" className={styles.title}>
							{pair.title}
						</Heading>
						<p className={styles.lead}>{pair.lead}</p>
					</header>
					<div className={styles.pair}>
						{pair.items.map((item) => (
							<div key={item.loop} className={styles.pairItem}>
								<div className={styles.frame}>
									<DemoLoop name={item.loop} />
								</div>
								<p className={styles.pairCaption}>{item.caption}</p>
							</div>
						))}
					</div>
				</article>
			</div>
		</section>
	);
}
