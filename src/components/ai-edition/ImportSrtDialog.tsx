import { useEffect, useRef, useState } from "react";
import { useScopedT } from "@/contexts/I18nContext";
import { withTranscript } from "@/lib/ai-edition/document/transcript";
import type { AxcutAsset, AxcutTranscript } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { runTranscriptImport } from "@/lib/ai-edition/store/transcriptImport";
import { useTranscriptionStore } from "@/lib/ai-edition/store/transcriptionStore";
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

/** File input is user-granted text access; no filesystem IPC or HTML rendering. */
export function ImportSrtDialog({ onClose }: { onClose: () => void }) {
	const ts = useScopedT("settings");
	const tc = useScopedT("common");
	const document = useProjectStore((s) => s.document);
	const jobs = useTranscriptionStore((s) => s.jobs);
	const initialProject = useRef(document?.project.id);
	const voiceovers = new Set(
		document?.audioTracks.filter((t) => t.kind === "voiceover").map((t) => t.assetId),
	);
	const assets = document?.assets.filter((a) => a.kind === "video" || voiceovers.has(a.id)) ?? [];
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
			current.assets.find((a) => a.id === p.asset.id) === p.asset &&
			findAssetTranscript(current, p.asset.id) === p.previous &&
			!busy(p.asset.id)
		);
	};
	const commit = async (p: PendingImport) => {
		if (!valid(p)) {
			setPending(null);
			setError(ts("transcript.srt.stale"));
			return;
		}
		const current = useProjectStore.getState().document!;
		setWorking(true);
		try {
			const saved = await runTranscriptImport(p.projectId, p.asset.id, () =>
				useProjectStore
					.getState()
					.saveDocument(withTranscript(current, p.transcript), { history: true }),
			);
			if (saved) close();
			else setError(ts("transcript.srt.saveFailed"));
		} catch {
			setError(ts("transcript.srt.saveFailed"));
		} finally {
			setWorking(false);
		}
	};
	const read = async () => {
		const current = useProjectStore.getState().document;
		const asset = current?.assets.find((a) => a.id === assetId);
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
	return (
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
			<p>{ts("transcript.srt.sourceTime")}</p>
			<p>{ts("transcript.srt.estimated")}</p>
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
		</ModalShell>
	);
}
