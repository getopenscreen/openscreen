// The MCP server section of AI settings: turn the local server on, pick its
// port, and copy what an MCP client needs to connect. The server itself lives
// in electron/mcp/; this only drives it through the native bridge.

import { AlertCircle, Check, Copy, Eye, EyeOff, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useScopedT } from "@/contexts/I18nContext";
import { nativeBridgeClient } from "@/native/client";
import type { AiEditionMcpStatus } from "@/native/contracts";
import styles from "./NewEditorShell.module.css";

const CODEX_TOKEN_ENV = "OPENSCREEN_MCP_TOKEN";
const MASKED_TOKEN = "••••••••";

export function claudeCodeCommand(url: string, token: string): string {
	return `claude mcp add --transport http openscreen ${url} --header "Authorization: Bearer ${token}"`;
}

export function codexCommand(url: string): string {
	return `codex mcp add openscreen --url ${url} --bearer-token-env-var ${CODEX_TOKEN_ENV}`;
}

// Commands and the token wrap onto as many lines as they need. `nowrap` here made
// the `1fr` grid column as wide as the longest command, which pushed the copy
// buttons out of the dialog and gave the whole modal a horizontal scrollbar.
const codeStyle: React.CSSProperties = {
	flex: 1,
	minWidth: 0,
	whiteSpace: "pre-wrap",
	overflowWrap: "anywhere",
	padding: "6px 8px",
	borderRadius: 6,
	background: "var(--bg-2, rgba(127,127,127,0.12))",
	font: "12px/1.5 var(--font-mono)",
	color: "var(--fg-2)",
	// A command is copied and typed as-is, so it has to render as-is: Geist Mono's
	// contextual alternates drew " --header" as "--header", hiding the space.
	fontVariantLigatures: "none",
	fontFeatureSettings: '"liga" 0, "calt" 0',
	userSelect: "text",
};

const rowStyle: React.CSSProperties = {
	display: "flex",
	alignItems: "flex-start",
	gap: 8,
	minWidth: 0,
};

export function McpServerSettings({ open }: { open: boolean }) {
	const te = useScopedT("editor");
	const [status, setStatus] = useState<AiEditionMcpStatus | null>(null);
	const [portDraft, setPortDraft] = useState("");
	const [busy, setBusy] = useState(false);
	const [showToken, setShowToken] = useState(false);

	const adopt = useCallback((next: AiEditionMcpStatus) => {
		setStatus(next);
		setPortDraft(String(next.port));
	}, []);

	useEffect(() => {
		if (!open) {
			setShowToken(false);
			return;
		}
		// Any failure, even a synchronous one, just hides the section: it must never
		// take the provider settings around it down with it.
		void Promise.resolve()
			.then(() => nativeBridgeClient.aiEdition.mcpGetStatus())
			.then(adopt, () => setStatus(null));
	}, [open, adopt]);

	const run = async (task: () => Promise<AiEditionMcpStatus>) => {
		setBusy(true);
		try {
			adopt(await task());
		} catch (err) {
			toast.error(te("mcpServer.updateFailed"), {
				description: err instanceof Error ? err.message : String(err),
			});
		} finally {
			setBusy(false);
		}
	};

	const copy = (text: string) => {
		const bridge = window.electronAPI?.copyToClipboard;
		const write = bridge ? bridge(text) : navigator.clipboard.writeText(text);
		void write.then(
			() => toast.success(te("mcpServer.copied")),
			() => toast.error(te("mcpServer.copyFailed")),
		);
	};

	if (!status) return null;

	const port = Number(portDraft);
	const portChanged = portDraft !== String(status.port);
	const token = status.token;
	const shownToken = token && showToken ? token : MASKED_TOKEN;

	return (
		<section
			data-testid="mcp-server-settings"
			style={{
				marginTop: 20,
				paddingTop: 16,
				borderTop: "1px solid var(--line, rgba(127,127,127,0.2))",
			}}
		>
			<div className={styles.providerForm} style={{ padding: 0 }}>
				<div className={styles.title}>
					<h3>{te("mcpServer.title")}</h3>
					{status.running ? (
						<span className={`${styles.statusPill} ${styles.ready}`}>
							<Check size={12} />
							{te("mcpServer.statusRunning")}
						</span>
					) : (
						<span className={`${styles.statusPill} ${styles.idle}`}>
							{status.enabled ? te("mcpServer.statusError") : te("mcpServer.statusOff")}
						</span>
					)}
				</div>
				<p className={styles.hint}>{te("mcpServer.description")}</p>

				<ToggleField
					label={te("mcpServer.enableLabel")}
					text={te("mcpServer.enable")}
					testId="mcp-server-toggle"
					on={status.enabled}
					disabled={busy}
					onToggle={() => run(() => nativeBridgeClient.aiEdition.mcpSetEnabled(!status.enabled))}
				/>

				<ToggleField
					label={te("mcpServer.editsLabel")}
					text={te("mcpServer.allowEdits")}
					hint={te("mcpServer.editsHint")}
					testId="mcp-edits-toggle"
					on={status.allowEdits}
					disabled={busy}
					onToggle={() =>
						run(() => nativeBridgeClient.aiEdition.mcpSetAllowEdits(!status.allowEdits))
					}
				/>

				<div className={styles.field}>
					<label>{te("mcpServer.portLabel")}</label>
					<div style={rowStyle}>
						<input
							type="number"
							min={1024}
							max={65535}
							value={portDraft}
							onChange={(e) => setPortDraft(e.target.value)}
							disabled={busy}
							style={{ width: 120 }}
						/>
						{portChanged ? (
							<button
								type="button"
								className={`${styles.btn} ${styles.btnSecondary}`}
								disabled={busy || !Number.isInteger(port)}
								onClick={() => run(() => nativeBridgeClient.aiEdition.mcpSetPort(port))}
							>
								{te("mcpServer.portApply")}
							</button>
						) : null}
					</div>
				</div>

				{status.error ? (
					<p className={styles.errorRow}>
						<AlertCircle size={14} style={{ verticalAlign: "middle", marginRight: 6 }} />
						{status.error}
					</p>
				) : null}

				{status.enabled && token ? (
					<>
						<div className={styles.field}>
							<label>{te("mcpServer.tokenLabel")}</label>
							<div style={rowStyle}>
								<code style={codeStyle}>{shownToken}</code>
								<IconButton
									label={showToken ? te("mcpServer.hide") : te("mcpServer.show")}
									onClick={() => setShowToken((v) => !v)}
								>
									{showToken ? <EyeOff size={14} /> : <Eye size={14} />}
								</IconButton>
								<IconButton label={te("mcpServer.copy")} onClick={() => copy(token)}>
									<Copy size={14} />
								</IconButton>
								<IconButton
									label={te("mcpServer.regenerate")}
									disabled={busy}
									onClick={() => run(() => nativeBridgeClient.aiEdition.mcpRegenerateToken())}
								>
									{busy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
								</IconButton>
							</div>
							<p className={styles.hint}>{te("mcpServer.tokenHint")}</p>
						</div>

						<div className={styles.field}>
							<label>{te("mcpServer.claudeCodeLabel")}</label>
							<div style={rowStyle}>
								<code style={codeStyle}>{claudeCodeCommand(status.url, shownToken)}</code>
								<IconButton
									label={te("mcpServer.copy")}
									onClick={() => copy(claudeCodeCommand(status.url, token))}
								>
									<Copy size={14} />
								</IconButton>
							</div>
						</div>

						<div className={styles.field}>
							<label>{te("mcpServer.codexLabel")}</label>
							<div style={rowStyle}>
								<code style={codeStyle}>{codexCommand(status.url)}</code>
								<IconButton
									label={te("mcpServer.copy")}
									onClick={() => copy(codexCommand(status.url))}
								>
									<Copy size={14} />
								</IconButton>
							</div>
							<p className={styles.hint}>{te("mcpServer.codexHint", { env: CODEX_TOKEN_ENV })}</p>
						</div>
					</>
				) : null}
			</div>
		</section>
	);
}

/** The panes' switch, not a system checkbox, inside its label so the text toggles it too. */
export function ToggleField({
	label,
	text,
	hint,
	testId,
	on,
	disabled,
	onToggle,
}: {
	label: string;
	text: string;
	hint?: string;
	testId: string;
	on: boolean;
	disabled: boolean;
	onToggle: () => void;
}) {
	return (
		<div className={styles.field}>
			<label>{label}</label>
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
					data-testid={testId}
					className={`${styles.toggle} ${on ? styles.isOn : ""}`}
					aria-pressed={on}
					disabled={disabled}
					onClick={onToggle}
				/>
				{text}
			</label>
			{hint ? <p className={styles.hint}>{hint}</p> : null}
		</div>
	);
}

function IconButton({
	label,
	onClick,
	disabled,
	children,
}: {
	label: string;
	onClick: () => void;
	disabled?: boolean;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			className={`${styles.btn} ${styles.btnSecondary}`}
			style={{ flexShrink: 0 }}
			title={label}
			aria-label={label}
			onClick={onClick}
			disabled={disabled}
		>
			{children}
		</button>
	);
}
