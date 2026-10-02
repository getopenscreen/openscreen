/**
 * A short silent loop of the app, in the style the category's own sites use:
 * no words in the picture, the page around it carries them.
 *
 * `<video>` has no `loading="lazy"`, so every part of the laziness is done here:
 *
 *   - Nothing but an empty 16:9 box is in the server HTML. The sources and the
 *     poster are attached when the box comes within a screen of the viewport,
 *     so a reader who never scrolls to a loop downloads none of it, poster
 *     included (a `poster` attribute in the markup is fetched eagerly).
 *   - Which file is decided at that moment, from the box's real width: 720p for
 *     a phone column or a 1× display, 1080p when the pixels are there to show
 *     it. HEVC first, H.264 for engines that cannot decode it.
 *   - It plays only while at least half of it is on screen, and pauses when it
 *     leaves, so a page with ten loops decodes one or two at a time.
 *   - No autoplay for a reader who asked for reduced motion or for Save-Data:
 *     they get the poster and a play button, and the sources are not even in
 *     the DOM before that click. Turning reduced motion on while the page is
 *     open stops a loop that was playing.
 *   - A visible pause button on every loop. A loop runs past five seconds and
 *     never stops, which WCAG 2.2.2 does not allow without one.
 *
 * The files carry no audio track: WebKit only autoplays without a gesture when
 * there is none, `muted` alone is not enough on iOS.
 */

import Head from "@docusaurus/Head";
import { translate } from "@docusaurus/Translate";
import { Pause, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
	type LoopHeight,
	type LoopName,
	loopPoster,
	loopSources,
	pickHeight,
} from "../../lib/demo-loop";
import { jsonLd, videoObjectLd } from "../../lib/structured-data";
import { loopLabel, loopTitle } from "./labels";
import styles from "./styles.module.css";

type Props = {
	name: LoopName;
	/** Off when the loop is one of several taking turns on a stage: it plays
	 *  once, then `onEnded` hands over to the next. */
	loop?: boolean;
	onEnded?: () => void;
	/** Called every frame while playing, with the share of the clip played. */
	onProgress?: (fraction: number) => void;
	/** Called once the first frame is decoded, so a stage can fade to it. */
	onReady?: () => void;
	/** Off on a stage, which declares all of its tabs' loops itself. */
	schema?: boolean;
};

/**
 * The schema.org VideoObject for loops the page presents, in the server HTML.
 * One <script> for the lot, as an @graph.
 */
export function LoopSchema({ names }: { names: LoopName[] }) {
	return (
		<Head>
			<script type="application/ld+json">
				{jsonLd(...names.map((n) => videoObjectLd(n, loopTitle(n), loopLabel(n))))}
			</script>
		</Head>
	);
}

function motionAllowed(): boolean {
	try {
		const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection
			?.saveData;
		return !reduced && !saveData;
	} catch {
		return true;
	}
}

export default function DemoLoop({
	name,
	loop = true,
	onEnded,
	onProgress,
	onReady,
	schema = true,
}: Props) {
	const box = useRef<HTMLDivElement>(null);
	const video = useRef<HTMLVideoElement>(null);
	const [height, setHeight] = useState<LoopHeight | null>(null);
	const [playing, setPlaying] = useState(false);
	// null until the reader decides; then their choice beats visibility.
	const [wanted, setWanted] = useState<boolean | null>(null);
	const visible = useRef(false);
	// State, not a ref: it decides whether the sources are in the DOM at all.
	const [auto, setAuto] = useState(true);

	// Follow the reader's motion setting, including a change made while the
	// page is open: turning on reduced motion stops a loop that is playing.
	useEffect(() => {
		setAuto(motionAllowed());
		let mq: MediaQueryList;
		try {
			mq = window.matchMedia("(prefers-reduced-motion: reduce)");
		} catch {
			return;
		}
		const onChange = () => setAuto(motionAllowed());
		mq.addEventListener("change", onChange);
		return () => mq.removeEventListener("change", onChange);
	}, []);

	// Attach the poster (and pick the file) once the box is within one screen
	// height. In pixels: a percentage rootMargin resolves against the root's
	// width, which on a portrait phone is well under a screen of lead.
	useEffect(() => {
		const el = box.current;
		if (!el) return;
		const io = new IntersectionObserver(
			(entries) => {
				if (!entries.some((e) => e.isIntersecting)) return;
				io.disconnect();
				setHeight(pickHeight(el.clientWidth, window.devicePixelRatio));
			},
			{ rootMargin: `${Math.round(window.innerHeight)}px 0px` },
		);
		io.observe(el);
		return () => io.disconnect();
	}, []);

	// Play while on screen, unless the reader said otherwise.
	useEffect(() => {
		const el = box.current;
		const v = video.current;
		if (!el || !v || height === null) return;
		const sync = () => {
			const go = wanted ?? (auto && visible.current);
			if (go && visible.current) {
				v.play().catch(() => setPlaying(false));
			} else {
				v.pause();
			}
		};
		const io = new IntersectionObserver(
			(entries) => {
				visible.current = entries[entries.length - 1].intersectionRatio >= 0.5;
				sync();
			},
			{ threshold: [0, 0.5] },
		);
		io.observe(el);
		sync();
		// A loop already on screen when its sources attach gets its play() while
		// the browser is still choosing a source, which aborts it, and no
		// threshold is crossed afterwards to ask again. Ask once there is a frame.
		v.addEventListener("loadeddata", sync);
		return () => {
			io.disconnect();
			v.removeEventListener("loadeddata", sync);
		};
	}, [height, wanted, auto]);

	// Progress for a stage's tab bar, per frame rather than per `timeupdate`,
	// which fires four times a second and would step the bar visibly.
	useEffect(() => {
		const v = video.current;
		if (!v || !onProgress || !playing) return;
		let raf = 0;
		const tick = () => {
			if (v.duration > 0) onProgress(Math.min(v.currentTime / v.duration, 1));
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, [playing, onProgress]);

	const label = loopLabel(name);
	const toggle = playing
		? translate({ id: "demoLoop.pause", message: "Pause video" })
		: translate({ id: "demoLoop.play", message: "Play video" });

	return (
		<figure className={styles.figure}>
			{schema && <LoopSchema names={[name]} />}
			<div ref={box} className={styles.box}>
				<video
					ref={video}
					className={styles.video}
					aria-label={label}
					poster={height ? loopPoster(name) : undefined}
					muted
					loop={loop}
					playsInline
					preload={height && auto ? "auto" : "none"}
					disablePictureInPicture
					disableRemotePlayback
					onPlay={() => setPlaying(true)}
					onPause={() => setPlaying(false)}
					onEnded={onEnded}
					onLoadedData={onReady}
				>
					{/* Without autoplay (reduced motion, Save-Data) the sources wait for
					    the play button: `preload="none"` is only a hint, and some engines
					    fetch anyway once a source is there. */}
					{height &&
						(auto || wanted === true) &&
						loopSources(name, height).map((s) => <source key={s.src} src={s.src} type={s.type} />)}
				</video>
				{height && (
					<button
						type="button"
						className={`${styles.toggle} ${playing ? "" : styles.toggleIdle}`}
						aria-label={toggle}
						title={toggle}
						onClick={() => setWanted(!playing)}
					>
						{playing ? <Pause size={16} /> : <Play size={16} />}
					</button>
				)}
			</div>
		</figure>
	);
}
