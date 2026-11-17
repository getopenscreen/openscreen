import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useScopedT } from "@/contexts/I18nContext";
import { withTranscript } from "@/lib/ai-edition/document/transcript";
import type { AxcutAsset, AxcutDocument, AxcutTranscript } from "@/lib/ai-edition/schema";
import {
	saveWithDeadline,
	useProjectStore,
	waitForDocumentSaves,
} from "@/lib/ai-edition/store/projectStore";
import { runTranscriptImport } from "@/lib/ai-edition/store/transcriptImport";
import { useTranscriptionStore } from "@/lib/ai-edition/store/transcriptionStore";
import { isGeneratedAssetId } from "@/lib/ai-edition/timeline/clip-parts";
import { SrtImportError, transcriptFromSrt } from "@/lib/ai-edition/transcription/fromSrt";
import { findAssetTranscript } from "@/lib/ai-edition/transcription/status";
import { ModalShell } from "./Modals";
import styles from "./NewEditorShell.module.css";

interface PendingImport {
	transcript: AxcutTranscript;
	previous: AxcutTranscript | null;
	asset: AxcutAsset;
	projectId: string;
}

function importTargets(document: AxcutDocument | null): AxcutAsset[] {
	if (!document) return [];
	const voiceovers = new Set(
		document.audioTracks
			.filter((track) => track.kind === "voiceover")
			.map((track) => track.assetId),
	);
	return document.assets.filter(
		(asset) =>
			!isGeneratedAssetId(asset.id) && (asset.kind === "video" || voiceovers.has(asset.id)),
	);
}

/** File input is user-granted text access; no filesystem IPC or HTML rendering. */
export function ImportSrtDialog({ onClose }: { onClose: () => void }) {
	const ts = useScopedT("settings");
	const tc = useScopedT("common");
	const document = useProjectStore((s) => s.document);
	const jobs = useTranscriptionStore((s) => s.jobs);
	const initialProject = useRef(document?.project.id);
	const assets = importTargets(document);
	const [assetId, setAssetId] = useState(assets.length === 1 ? assets[0].id : "");
	const [file, setFile] = useState<File | null>(null);
	const [pending, setPending] = useState<PendingImport | null>(null);
	const [error, setError] = useState("");
	const [working, setWorking] = useState(false);
	const generation = useRef(0);
	useEffect(
		() => () => {
			generation.current++;
		},
		[],
	);
	const busy = (id: string) => {
		const job = useTranscriptionStore.getState().jobs[id];
		return job?.status === "running" || job?.status === "queued";
	};
	const close = () => {
		generation.current++;
		onClose();
	};
	const valid = (p: PendingImport) => {
		const current = useProjectStore.getState().document;
		return (
			current?.project.id === p.projectId &&
			current.project.id === initialProject.current &&
			importTargets(current).some((asset) => asset.id === p.asset.id) &&
			JSON.stringify(current.assets.find((a) => a.id === p.asset.id)) === JSON.stringify(p.asset) &&
			findAssetTranscript(current, p.asset.id) === p.previous &&
			!busy(p.asset.id)
		);
	};
	const commit = async (p: PendingImport) => {
		const token = generation.current;
		if (!valid(p)) {
			setPending(null);
			setError(ts("transcript.srt.stale"));
			return;
		}
		setWorking(true);
		try {
			const operation = runTranscriptImport(p.projectId, p.asset.id, async () => {
				if ((await waitForDocumentSaves()) !== "idle") return false;
				if (token !== generation.current) return "cancelled" as const;
				if (!valid(p)) {
					setPending(null);
					setError(ts("transcript.srt.stale"));
					return "stale" as const;
				}
				const current = useProjectStore.getState().document!;
				return useProjectStore
					.getState()
					.saveDocument(withTranscript(current, p.transcript), { history: true });
			});
			// A deadline releases the dialog, not the reservation: a late disk write
			// must still settle before transcription or a probe reads its document.
			const saved = await saveWithDeadline(operation);
			if (token !== generation.current) return;
			if (saved === true) close();
			else if (saved === false) setError(ts("transcript.srt.saveFailed"));
			else if (saved === "timeout") setError(ts("transcript.srt.savePending"));
		} catch {
			setError(ts("transcript.srt.saveFailed"));
		} finally {
			setWorking(false);
		}
	};
	const read = async () => {
		const current = useProjectStore.getState().document;
		const asset = importTargets(current).find((a) => a.id === assetId);
		if (
			!file ||
			!asset ||
			!current ||
			current.project.id !== initialProject.current ||
			busy(assetId)
		) {
			setError(ts("transcript.srt.stale"));
			return;
		}
		const p = {
			asset,
			projectId: current.project.id,
			previous: findAssetTranscript(current, assetId),
		};
		const token = ++generation.current;
		setWorking(true);
		setError("");
		try {
			const text = await file.text();
			if (token !== generation.current) return;
			const result = {
				...p,
				transcript: transcriptFromSrt(assetId, text, asset.durationSec ?? 0, file.name),
			};
			if (!valid(result)) {
				setError(ts("transcript.srt.stale"));
				return;
			}
			if (p.previous) setPending(result);
			else await commit(result);
		} catch (e) {
			if (token !== generation.current) return;
			setError(
				e instanceof SrtImportError
					? ts("transcript.srt.validation", {
							cue: e.cue,
							line: e.line,
							reason: ts(`transcript.srt.errors.${e.code}`),
						})
					: ts("transcript.srt.readFailed"),
			);
		} finally {
			setWorking(false);
		}
	};
	// The floating inspector is transformed and clips its children. Mount the
	// modal at the viewport so its backdrop and controls are not cut off by the pane.
	return createPortal(
		<ModalShell
			open
			onClose={close}
			title={ts("transcript.srt.title")}
			closeOnEscape={!working}
			closeOnBackdrop={!working}
			footer={
				<>
					<button type="button" className={styles.btn} disabled={working} onClick={close}>
						{tc("actions.cancel")}
					</button>
					<button
						type="button"
						className={`${styles.btn} ${styles.btnPrimary}`}
						disabled={working || !assetId || !file || busy(assetId)}
						onClick={() => void (pending ? commit(pending) : read())}
					>
						{ts(pending ? "transcript.srt.replace" : "transcript.srt.import")}
					</button>
				</>
			}
		>
			<label>
				{ts("transcript.srt.target")}
				<select
					value={assetId}
					disabled={working || !!pending}
					onChange={(e) => {
						generation.current++;
						setAssetId(e.target.value);
						setError("");
					}}
				>
					<option value="">{ts("transcript.srt.chooseTarget")}</option>
					{assets.map((a) => (
						<option
							key={a.id}
							value={a.id}
							disabled={jobs[a.id]?.status === "queued" || jobs[a.id]?.status === "running"}
						>
							{a.label}
							{jobs[a.id]?.status === "queued" || jobs[a.id]?.status === "running"
								? ` (${ts("transcript.srt.busy")})`
								: ""}
						</option>
					))}
				</select>
			</label>
			<label>
				{ts("transcript.srt.file")}
				<input
					type="file"
					accept=".srt,application/x-subrip"
					disabled={working || !!pending}
					onChange={(e) => {
						generation.current++;
						setFile(e.target.files?.[0] ?? null);
						setError("");
					}}
				/>
			</label>
			{pending ? <p>{ts("transcript.srt.replaceWarning", { name: pending.asset.label })}</p> : null}
			{error ? <p role="alert">{error}</p> : null}
		</ModalShell>,
		globalThis.document.body,
	);
}
