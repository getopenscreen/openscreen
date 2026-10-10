import * as Dialog from "@radix-ui/react-dialog";
import { Crosshair, RotateCcw, X } from "lucide-react";
import { type PointerEvent, useRef, useState } from "react";
import { useScopedT } from "@/contexts/I18nContext";
import {
	type CursorHotspot,
	type CustomCursorKind,
	defaultCursorHotspot,
} from "@/lib/cursor/cursorThemes";
import styles from "./CursorHotspotEditor.module.css";
import shell from "./NewEditorShell.module.css";

export interface CursorHotspotDraft {
	setId: string;
	kind: CustomCursorKind;
	image: string;
	hotspot: CursorHotspot;
}

export function CursorHotspotEditor({
	draft,
	onClose,
	onApply,
}: {
	draft: CursorHotspotDraft;
	onClose: () => void;
	onApply: (point: CursorHotspot) => Promise<boolean>;
}) {
	const ts = useScopedT("settings");
	const tc = useScopedT("common");
	const [point, setPoint] = useState({ ...draft.hotspot });
	const [dimensions, setDimensions] = useState({ width: 256, height: 256 });
	const [loaded, setLoaded] = useState(false);
	const [error, setError] = useState("");
	const [saving, setSaving] = useState(false);
	const [previewSize, setPreviewSize] = useState(64);
	const [dark, setDark] = useState(false);
	const planeRef = useRef<HTMLButtonElement>(null);
	const kindLabel = ts(
		draft.kind === "arrow"
			? "cursor.typeArrow"
			: draft.kind === "pointer"
				? "cursor.typePointer"
				: "cursor.typeText",
	);
	const clamp = (value: number) => Math.max(0, Math.min(1, value));
	const movePointer = (event: PointerEvent<HTMLButtonElement>) => {
		const rect = event.currentTarget.getBoundingClientRect();
		if (!rect.width || !rect.height) return;
		setPoint({
			x: clamp((event.clientX - rect.left) / rect.width),
			y: clamp((event.clientY - rect.top) / rect.height),
		});
	};
	const apply = async () => {
		if (!loaded || saving) return;
		setSaving(true);
		try {
			if (await onApply(point)) onClose();
			else setError(ts("cursor.hotspot.saveFailed"));
		} catch {
			setError(ts("cursor.hotspot.saveFailed"));
		} finally {
			setSaving(false);
		}
	};
	const scale = 260 / Math.max(dimensions.width, dimensions.height);
	return (
		<Dialog.Root
			open
			onOpenChange={(open) => {
				if (!open && !saving) onClose();
			}}
		>
			<Dialog.Portal>
				<Dialog.Overlay className={styles.overlay} />
				<Dialog.Content
					className={`${shell.modalCard} ${styles.dialog}`}
					aria-describedby={undefined}
					onPointerDownOutside={(event) => event.preventDefault()}
					onEscapeKeyDown={(event) => {
						event.stopPropagation();
						if (saving) event.preventDefault();
					}}
				>
					<header className={shell.modalHead}>
						<Dialog.Title asChild>
							<h2>{ts("cursor.hotspot.title", { type: kindLabel })}</h2>
						</Dialog.Title>
						<button
							type="button"
							className={shell.closeBtn}
							title={tc("actions.close")}
							aria-label={tc("actions.close")}
							disabled={saving}
							onClick={onClose}
						>
							<X size={18} />
						</button>
					</header>
					<div className={shell.modalBody}>
						<div className={styles.views}>
							<section className={styles.view}>
								<h3>{ts("cursor.hotspot.point")}</h3>
								<div className={styles.imageStage}>
									<button
										ref={planeRef}
										type="button"
										aria-label={ts("cursor.hotspot.point")}
										className={styles.imagePlane}
										disabled={!loaded || saving}
										style={{
											width: dimensions.width * scale,
											aspectRatio: `${dimensions.width}/${dimensions.height}`,
										}}
										onPointerDown={(event) => {
											if (event.button !== 0) return;
											event.currentTarget.setPointerCapture(event.pointerId);
											movePointer(event);
										}}
										onPointerMove={(event) => {
											if (event.currentTarget.hasPointerCapture(event.pointerId))
												movePointer(event);
										}}
										onPointerUp={(event) => {
											if (event.currentTarget.hasPointerCapture(event.pointerId)) {
												movePointer(event);
												event.currentTarget.releasePointerCapture(event.pointerId);
											}
										}}
										onKeyDown={(event) => {
											const directions: Record<string, [number, number]> = {
												ArrowLeft: [-1, 0],
												ArrowRight: [1, 0],
												ArrowUp: [0, -1],
												ArrowDown: [0, 1],
											};
											const direction = directions[event.key];
											if (!direction) return;
											event.preventDefault();
											event.stopPropagation();
											const step = event.shiftKey ? 10 : 1;
											setPoint((current) => ({
												x: clamp(current.x + (direction[0] * step) / dimensions.width),
												y: clamp(current.y + (direction[1] * step) / dimensions.height),
											}));
										}}
									>
										<img
											src={draft.image}
											alt={kindLabel}
											draggable={false}
											onLoad={(event) => {
												const image = event.currentTarget;
												if (image.naturalWidth > 0 && image.naturalHeight > 0)
													setDimensions({ width: image.naturalWidth, height: image.naturalHeight });
												setLoaded(true);
											}}
											onError={() => {
												setLoaded(false);
												setError(ts("background.imageReadFailed"));
											}}
										/>
										<Crosshair
											className={styles.marker}
											size={24}
											style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
											aria-hidden="true"
										/>
									</button>
								</div>
								<div className={styles.coordinates}>
									{(["x", "y"] as const).map((axis) => (
										<label key={axis}>
											{axis.toUpperCase()} %
											<input
												type="number"
												min="0"
												max="100"
												step="0.1"
												value={Number((point[axis] * 100).toFixed(2))}
												disabled={saving}
												onChange={(event) => {
													if (event.currentTarget.value === "") return;
													const value = event.currentTarget.valueAsNumber;
													if (Number.isFinite(value))
														setPoint((current) => ({ ...current, [axis]: clamp(value / 100) }));
												}}
											/>
										</label>
									))}
									<button
										type="button"
										className={styles.iconButton}
										title={ts("cursor.hotspot.reset")}
										aria-label={ts("cursor.hotspot.reset")}
										disabled={saving}
										onClick={() => setPoint(defaultCursorHotspot(draft.kind))}
									>
										<RotateCcw size={18} />
									</button>
								</div>
							</section>
							<section className={styles.view}>
								<h3>{ts("cursor.hotspot.preview")}</h3>
								<div className={`${styles.preview} ${dark ? styles.dark : ""}`}>
									<Crosshair className={styles.target} size={32} aria-hidden="true" />
									<img
										src={draft.image}
										alt={ts("cursor.hotspot.preview")}
										draggable={false}
										style={{
											width:
												(previewSize * dimensions.width) /
												Math.max(dimensions.width, dimensions.height),
											height:
												(previewSize * dimensions.height) /
												Math.max(dimensions.width, dimensions.height),
											transform: `translate(${-point.x * 100}%, ${-point.y * 100}%)`,
										}}
									/>
								</div>
								<label className={styles.size}>
									{ts("cursor.hotspot.previewSize")}
									<input
										type="range"
										min="24"
										max="128"
										value={previewSize}
										onChange={(event) => setPreviewSize(Number(event.currentTarget.value))}
									/>
								</label>
								<label className={styles.darkToggle}>
									<input
										type="checkbox"
										checked={dark}
										onChange={(event) => setDark(event.currentTarget.checked)}
									/>
									{ts("cursor.hotspot.darkBackground")}
								</label>
							</section>
						</div>
						{error ? (
							<p className={styles.error} role="alert">
								{error}
							</p>
						) : null}
					</div>
					<footer className={`${shell.modalFoot} ${styles.footer}`}>
						<button
							type="button"
							className={`${shell.btn} ${shell.btnSecondary}`}
							disabled={saving}
							onClick={onClose}
						>
							{tc("actions.cancel")}
						</button>
						<button
							type="button"
							className={`${shell.btn} ${shell.btnPrimary}`}
							disabled={!loaded || saving}
							onClick={() => void apply()}
						>
							{ts("cursor.hotspot.apply")}
						</button>
					</footer>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
