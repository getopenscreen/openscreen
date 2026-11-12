// Google Drive settings: the OAuth client to sign in with, the connection, and the switch that
// turns syncing on and off. The sync itself lives in electron/drive/; this only drives it
// through the native bridge.

import { Check, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useEditorDialogActions, useEditorDialogSection } from "@/contexts/EditorDialogsContext";
import { useScopedT } from "@/contexts/I18nContext";
import { nativeBridgeClient } from "@/native/client";
import type { DriveStatus } from "@/native/contracts";
import { ModalShell } from "./Modals";
import styles from "./NewEditorShell.module.css";

export function GoogleDriveSettings({ open, onClose }: { open: boolean; onClose: () => void }) {
	const te = useScopedT("editor");
	const [status, setStatus] = useState<DriveStatus | null>(null);
	const [loadFailed, setLoadFailed] = useState(false);
	const [busy, setBusy] = useState<"connect" | "other" | null>(null);
	const [editingClient, setEditingClient] = useState(false);
	const [clientId, setClientId] = useState("");
	const [clientSecret, setClientSecret] = useState("");

	const adopt = useCallback((next: DriveStatus) => {
		setStatus(next);
		setClientId(next.clientId ?? "");
		setClientSecret("");
		setEditingClient(false);
	}, []);

	useEffect(() => {
		if (!open) return;
		setLoadFailed(false);
		void Promise.resolve()
			.then(() => nativeBridgeClient.drive.getStatus())
			.then(adopt, () => setLoadFailed(true));
	}, [open, adopt]);

	const run = async (kind: "connect" | "other", task: () => Promise<DriveStatus>) => {
		setBusy(kind);
		try {
			adopt(await task());
		} catch (err) {
			toast.error(te("drive.updateFailed"), {
				description: err instanceof Error ? err.message : String(err),
			});
		} finally {
			setBusy(null);
		}
	};

	const showClientForm = status
		? !status.clientFromEnv && (!status.configured || editingClient)
		: false;

	return (
		<ModalShell
			open={open}
			onClose={onClose}
			title={te("drive.title")}
			subtitle={te("drive.subtitle")}
		>
			{loadFailed ? <p className={styles.errorRow}>{te("drive.unavailable")}</p> : null}
			{status ? (
				<div className={styles.providerForm} style={{ padding: 0 }} data-testid="drive-settings">
					<div className={styles.title}>
						<h3>{te("drive.title")}</h3>
						{status.connected ? (
							<span className={`${styles.statusPill} ${styles.ready}`}>
								<Check size={12} />
								{te("drive.statusConnected")}
							</span>
						) : (
							<span className={`${styles.statusPill} ${styles.idle}`}>
								{te("drive.statusNotConnected")}
							</span>
						)}
					</div>

					{showClientForm ? (
						<>
							<p className={styles.hint}>{te("drive.clientHint")}</p>
							<div className={styles.field}>
								<label htmlFor="drive-client-id">{te("drive.clientIdLabel")}</label>
								<input
									id="drive-client-id"
									value={clientId}
									onChange={(e) => setClientId(e.target.value)}
									placeholder="1234-abcd.apps.googleusercontent.com"
									disabled={busy !== null}
									spellCheck={false}
								/>
							</div>
							<div className={styles.field}>
								<label htmlFor="drive-client-secret">{te("drive.clientSecretLabel")}</label>
								<input
									id="drive-client-secret"
									type="password"
									value={clientSecret}
									onChange={(e) => setClientSecret(e.target.value)}
									disabled={busy !== null}
									spellCheck={false}
								/>
							</div>
							<div style={{ display: "flex", gap: 8 }}>
								<button
									type="button"
									className={`${styles.btn} ${styles.btnPrimary}`}
									data-testid="drive-save-client"
									disabled={busy !== null || clientId.trim().length === 0}
									onClick={() =>
										run("other", () => nativeBridgeClient.drive.setClient(clientId, clientSecret))
									}
								>
									{te("drive.saveClient")}
								</button>
								{editingClient ? (
									<button
										type="button"
										className={`${styles.btn} ${styles.btnSecondary}`}
										onClick={() => setEditingClient(false)}
									>
										{te("drive.cancelClient")}
									</button>
								) : null}
							</div>
						</>
					) : status.connected ? (
						<>
							<p className={styles.hint}>
								{te("drive.connectedAs", { account: status.accountEmail ?? "" })}
							</p>
							<div className={styles.field}>
								<label>{te("drive.syncLabel")}</label>
								<label
									style={{
										display: "flex",
										alignItems: "center",
										gap: 10,
										font: "500 13px var(--font-body)",
										color: "var(--fg-2)",
										cursor: "pointer",
									}}
								>
									<button
										type="button"
										data-testid="drive-sync-toggle"
										className={`${styles.toggle} ${status.syncEnabled ? styles.isOn : ""}`}
										aria-pressed={status.syncEnabled}
										disabled={busy !== null}
										onClick={() =>
											run("other", () =>
												nativeBridgeClient.drive.setSyncEnabled(!status.syncEnabled),
											)
										}
									/>
									{te("drive.syncToggle")}
								</label>
								<p className={styles.hint}>{te("drive.syncHint")}</p>
							</div>
							<div>
								<button
									type="button"
									className={`${styles.btn} ${styles.btnSecondary}`}
									data-testid="drive-disconnect"
									disabled={busy !== null}
									onClick={() => run("other", () => nativeBridgeClient.drive.disconnect())}
								>
									{te("drive.disconnect")}
								</button>
							</div>
						</>
					) : (
						<>
							<p className={styles.hint}>{te("drive.connectHint")}</p>
							<div style={{ display: "flex", gap: 8, alignItems: "center" }}>
								<button
									type="button"
									className={`${styles.btn} ${styles.btnPrimary}`}
									data-testid="drive-connect"
									disabled={busy !== null}
									onClick={() => run("connect", () => nativeBridgeClient.drive.connect())}
								>
									{busy === "connect" ? <Loader2 size={14} className="animate-spin" /> : null}
									{te("drive.connect")}
								</button>
								{status.clientFromEnv ? null : (
									<button
										type="button"
										className={`${styles.btn} ${styles.btnSecondary}`}
										disabled={busy !== null}
										onClick={() => setEditingClient(true)}
									>
										{te("drive.changeClient")}
									</button>
								)}
							</div>
							{busy === "connect" ? (
								<p className={styles.hint}>{te("drive.waitingForBrowser")}</p>
							) : null}
						</>
					)}
				</div>
			) : null}
		</ModalShell>
	);
}

/** The dialog's one mount, in App.tsx beside the AI settings dialog. */
export function GoogleDriveSettingsDialog() {
	const section = useEditorDialogSection();
	const { closeDialog } = useEditorDialogActions();
	return <GoogleDriveSettings open={section === "drive"} onClose={closeDialog} />;
}
