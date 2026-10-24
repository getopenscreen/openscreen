import { FolderSearch, Loader2, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useScopedT } from "@/contexts/I18nContext";
import type {
	AiEditionRecording,
	AiEditionRecordingsDeleteResult,
	AiEditionRecordingsListResult,
} from "@/native/contracts";
import { formatBytes } from "@/utils/formatBytes";
import { getPlatform } from "@/utils/platformUtils";
import { ModalShell } from "./Modals";
import styles from "./NewEditorShell.module.css";

interface ManageRecordingsModalProps {
	open: boolean;
	onClose: () => void;
	loadRecordings: () => Promise<AiEditionRecordingsListResult>;
	deleteRecordings: (
		ids: string[],
		disposal: "trash" | "permanent",
	) => Promise<AiEditionRecordingsDeleteResult>;
	onReveal?: (filePath: string) => void;
}

const VIDEO_EXTENSIONS = [".mp4", ".webm", ".mov"];

/** The screen video, which is what "Show in folder" points at. */
function screenVideo(recording: AiEditionRecording): string {
	return (
		recording.files.find((file) =>
			VIDEO_EXTENSIONS.some((ext) => file.endsWith(`${recording.stem}${ext}`)),
		) ?? recording.files[0]
	);
}

const mutedLine = {
	font: "400 12px/1.4 var(--font-body)",
	color: "var(--muted)",
} as const;

export function ManageRecordingsModal({
	open,
	onClose,
	loadRecordings,
	deleteRecordings,
	onReveal,
}: ManageRecordingsModalProps) {
	const t = useScopedT("editor");
	const tc = useScopedT("common");
	const [listing, setListing] = useState<AiEditionRecordingsListResult | null>(null);
	const [selected, setSelected] = useState<Set<string>>(() => new Set());
	const [confirming, setConfirming] = useState(false);
	const [trashFailed, setTrashFailed] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const recycleBin = getPlatform() === "win32";

	const reload = useCallback(async () => {
		let result: AiEditionRecordingsListResult;
		try {
			result = await loadRecordings();
		} catch (error) {
			result = { success: false, recordings: [], unreadable: 0, error: String(error) };
		}
		setListing(result);
		// A take deleted elsewhere drops out of the selection with the list.
		const ids = new Set(result.recordings.map((r) => r.id));
		setSelected((prev) => new Set([...prev].filter((id) => ids.has(id))));
	}, [loadRecordings]);

	useEffect(() => {
		if (!open) return;
		setListing(null);
		setSelected(new Set());
		setConfirming(false);
		setTrashFailed(false);
		void reload();
	}, [open, reload]);

	const recordings = listing?.recordings ?? [];
	const chosen = recordings.filter((r) => selected.has(r.id));
	const chosenSize = chosen.reduce((sum, r) => sum + r.sizeBytes, 0);
	const totalSize = recordings.reduce((sum, r) => sum + r.sizeBytes, 0);
	const inUseBy = [...new Set(chosen.flatMap((r) => r.usedBy))];
	const unreadable = listing?.unreadable ?? 0;

	const toggle = (id: string) => {
		setConfirming(false);
		setTrashFailed(false);
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};
	const select = (ids: string[]) => {
		setConfirming(false);
		setTrashFailed(false);
		setSelected(new Set(ids));
	};

	const runDelete = async () => {
		setDeleting(true);
		try {
			const result = await deleteRecordings(
				chosen.map((r) => r.id),
				trashFailed ? "permanent" : "trash",
			);
			if (!result.success && result.trashFailed) {
				setTrashFailed(true);
			} else {
				setConfirming(false);
				setTrashFailed(false);
			}
			await reload();
		} finally {
			setDeleting(false);
		}
	};

	const footer = confirming ? (
		<div style={{ display: "flex", alignItems: "center", gap: 8, width: "100%" }}>
			<div style={{ flex: 1, minWidth: 0 }}>
				<div style={{ font: "500 13px/1.3 var(--font-body)" }}>
					{trashFailed
						? t(recycleBin ? "openProjectDialog.recycleFailed" : "openProjectDialog.trashFailed")
						: t(recycleBin ? "recordingsDialog.confirmRecycle" : "recordingsDialog.confirmTrash", {
								size: formatBytes(chosenSize),
							})}
				</div>
				{inUseBy.length > 0 ? (
					<div style={{ ...mutedLine, color: "var(--danger)", marginTop: 4 }}>
						{t("recordingsDialog.inUseWarning", { projects: inUseBy.join(", ") })}
					</div>
				) : null}
				{unreadable > 0 ? (
					<div style={{ ...mutedLine, marginTop: 4 }}>{t("recordingsDialog.unreadable")}</div>
				) : null}
			</div>
			<button
				type="button"
				className={`${styles.btn} ${styles.btnSecondary}`}
				onClick={() => {
					setConfirming(false);
					setTrashFailed(false);
				}}
			>
				{tc("actions.cancel")}
			</button>
			<button
				type="button"
				className={`${styles.btn} ${styles.dangerBtn}`}
				disabled={deleting}
				onClick={() => void runDelete()}
			>
				<Trash2 size={14} />
				{trashFailed
					? t("openProjectDialog.deletePermanently")
					: t(recycleBin ? "recordingsDialog.moveToRecycle" : "recordingsDialog.moveToTrash")}
			</button>
		</div>
	) : (
		<div style={{ display: "flex", alignItems: "center", gap: 8, width: "100%" }}>
			<span style={{ ...mutedLine, flex: 1 }}>
				{chosen.length > 0
					? t("recordingsDialog.selected", {
							count: chosen.length,
							size: formatBytes(chosenSize),
						})
					: t("recordingsDialog.total", { size: formatBytes(totalSize) })}
			</span>
			<button
				type="button"
				className={`${styles.btn} ${styles.btnSecondary}`}
				disabled={recordings.length === 0}
				onClick={() => select(recordings.filter((r) => r.usedBy.length === 0).map((r) => r.id))}
			>
				{t("recordingsDialog.selectUnused")}
			</button>
			<button
				type="button"
				className={`${styles.btn} ${styles.btnSecondary}`}
				disabled={recordings.length === 0}
				onClick={() =>
					select(chosen.length === recordings.length ? [] : recordings.map((r) => r.id))
				}
			>
				{chosen.length === recordings.length && recordings.length > 0
					? t("recordingsDialog.clearSelection")
					: t("recordingsDialog.selectAll")}
			</button>
			<button
				type="button"
				className={`${styles.btn} ${styles.dangerBtn}`}
				disabled={chosen.length === 0}
				onClick={() => setConfirming(true)}
			>
				<Trash2 size={14} />
				{t("recordingsDialog.deleteSelected")}
			</button>
		</div>
	);

	return (
		<ModalShell
			open={open}
			onClose={onClose}
			title={t("recordingsDialog.title")}
			subtitle={t("recordingsDialog.subtitle")}
			wide
			footer={footer}
		>
			{unreadable > 0 ? (
				<p
					style={{
						...mutedLine,
						margin: "0 0 12px",
						padding: "8px 12px",
						borderRadius: "var(--r-md)",
						background: "var(--surface-2)",
					}}
				>
					{t("recordingsDialog.unreadable")}
				</p>
			) : null}
			{listing === null ? (
				<p style={{ ...mutedLine, display: "flex", alignItems: "center", gap: 8, padding: 16 }}>
					<Loader2 size={14} className="animate-spin" />
					{t("recordingsDialog.loading")}
				</p>
			) : !listing.success ? (
				<p style={{ ...mutedLine, padding: 16, textAlign: "center" }}>
					{t("recordingsDialog.loadFailed")}
				</p>
			) : recordings.length === 0 ? (
				<p style={{ ...mutedLine, padding: 16, textAlign: "center" }}>
					{t("recordingsDialog.empty")}
				</p>
			) : (
				<ul
					style={{
						listStyle: "none",
						margin: 0,
						padding: 0,
						display: "flex",
						flexDirection: "column",
						gap: 2,
						maxHeight: "48vh",
						overflowY: "auto",
						scrollbarWidth: "thin",
						scrollbarColor: "var(--border-hi) transparent",
					}}
				>
					{recordings.map((recording) => {
						const label = new Date(recording.recordedAt).toLocaleString();
						const checked = selected.has(recording.id);
						return (
							<li
								key={recording.id}
								style={{
									display: "flex",
									alignItems: "center",
									gap: 12,
									padding: "8px 12px",
									borderRadius: "var(--r-md)",
									background: checked ? "var(--accent-soft)" : "transparent",
								}}
							>
								<label
									style={{
										flex: 1,
										minWidth: 0,
										display: "flex",
										alignItems: "center",
										gap: 12,
										cursor: "pointer",
									}}
								>
									<input
										type="checkbox"
										checked={checked}
										onChange={() => toggle(recording.id)}
										style={{ accentColor: "var(--accent)" }}
									/>
									<span style={{ minWidth: 0, flex: 1 }}>
										<span style={{ display: "block", font: "500 13px/1.3 var(--font-body)" }}>
											{label}
										</span>
										<span
											style={{
												...mutedLine,
												display: "block",
												overflow: "hidden",
												textOverflow: "ellipsis",
												whiteSpace: "nowrap",
											}}
										>
											{recording.usedBy.length > 0
												? t("recordingsDialog.usedBy", { projects: recording.usedBy.join(", ") })
												: t("recordingsDialog.unused")}
										</span>
									</span>
									<span
										style={{
											...mutedLine,
											fontVariantNumeric: "tabular-nums",
											whiteSpace: "nowrap",
										}}
									>
										{formatBytes(recording.sizeBytes)}
									</span>
								</label>
								{onReveal ? (
									<button
										type="button"
										className={styles.iconBtn}
										onClick={() => onReveal(screenVideo(recording))}
										title={t("recordingsDialog.showInFolder")}
										aria-label={t("recordingsDialog.showInFolder")}
									>
										<FolderSearch size={14} />
									</button>
								) : null}
							</li>
						);
					})}
				</ul>
			)}
		</ModalShell>
	);
}
