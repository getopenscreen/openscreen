// The Google Drive side of a row in the Open project list: the badge that says the project's
// video is in Drive, and the row's menu that shares it, changes who can open it, or stops
// syncing it.

import { AlertTriangle, Check, Link2, Loader2, MoreVertical, Unlink } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useScopedT } from "@/contexts/I18nContext";
import { moveMenuFocus } from "@/lib/menuKeyboard";
import type { DriveProjectState, DriveVisibility } from "@/native/contracts";
import styles from "./NewEditorShell.module.css";

/** A plain three-sided Drive mark, drawn in the current colour so it follows the theme. */
export function DriveIcon({ size = 14 }: { size?: number }) {
	return (
		<svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
			<path
				d="M8.6 3h6.8l6.1 10.6-3.4 5.9H5.9L2.5 13.6 8.6 3Z"
				stroke="currentColor"
				strokeWidth="1.8"
				strokeLinejoin="round"
			/>
			<path
				d="M8.6 3l6.4 10.6H2.5M15.4 3 9 13.6l-3.1 5.9M21.5 13.6H9"
				stroke="currentColor"
				strokeWidth="1.4"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

/** The badge beside the title: in Drive, uploading, or the last upload failed. */
export function DriveBadge({ state }: { state: DriveProjectState }) {
	const t = useScopedT("editor");
	const label =
		state.status === "uploading"
			? t("drive.badgeUploading")
			: state.status === "error"
				? t("drive.badgeFailed", { error: state.error ?? "" })
				: t("drive.badgeSynced");
	return (
		<span
			data-testid="drive-badge"
			data-status={state.status}
			title={label}
			aria-label={label}
			role="img"
			style={{
				display: "inline-flex",
				alignItems: "center",
				flexShrink: 0,
				color: state.status === "error" ? "var(--danger)" : "var(--muted)",
			}}
		>
			{state.status === "uploading" ? (
				<Loader2 size={13} className="animate-spin" />
			) : state.status === "error" ? (
				<AlertTriangle size={13} />
			) : (
				<DriveIcon size={13} />
			)}
		</span>
	);
}

interface ProjectDriveMenuProps {
	state: DriveProjectState;
	onShare: () => void;
	onSetVisibility: (visibility: DriveVisibility) => void;
	onUnsync: () => void;
}

const VISIBILITIES: Array<{ id: DriveVisibility; labelKey: string }> = [
	{ id: "private", labelKey: "drive.visibilityPrivate" },
	{ id: "anyone", labelKey: "drive.visibilityAnyone" },
];

export function ProjectDriveMenu({
	state,
	onShare,
	onSetVisibility,
	onUnsync,
}: ProjectDriveMenuProps) {
	const t = useScopedT("editor");
	const [open, setOpen] = useState(false);
	const [visibilityOpen, setVisibilityOpen] = useState(false);
	const ref = useRef<HTMLDivElement | null>(null);
	const menuRef = useRef<HTMLDivElement | null>(null);
	const triggerRef = useRef<HTMLButtonElement | null>(null);

	useEffect(() => {
		if (!open) {
			setVisibilityOpen(false);
			return;
		}
		menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
		const onDocMouseDown = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
		};
		document.addEventListener("mousedown", onDocMouseDown);
		return () => document.removeEventListener("mousedown", onDocMouseDown);
	}, [open]);

	const run = (action: () => void) => () => {
		setOpen(false);
		action();
	};
	const hasFile = state.fileId !== null && state.webViewLink !== null;

	return (
		<div ref={ref} style={{ position: "relative" }}>
			<button
				ref={triggerRef}
				type="button"
				className={styles.iconBtn}
				data-testid="project-drive-menu"
				aria-haspopup="menu"
				aria-expanded={open}
				title={t("drive.menuLabel")}
				aria-label={t("drive.menuLabel")}
				onClick={() => setOpen((v) => !v)}
			>
				<MoreVertical size={14} />
			</button>
			{open ? (
				<div
					ref={menuRef}
					role="menu"
					aria-label={t("drive.menuLabel")}
					onKeyDown={(e) => {
						// The dialog closes on Escape too; this one press only closes the menu.
						if (e.key === "Escape") {
							e.preventDefault();
							e.stopPropagation();
							setOpen(false);
							triggerRef.current?.focus();
							return;
						}
						moveMenuFocus(e);
					}}
					style={{
						position: "absolute",
						right: 0,
						top: "calc(100% + 4px)",
						zIndex: 10,
						minWidth: 220,
						padding: 4,
						display: "flex",
						flexDirection: "column",
						borderRadius: "var(--r-md)",
						background: "var(--surface)",
						border: "1px solid var(--border)",
						boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
					}}
				>
					<MenuRow disabled={!hasFile} onClick={run(onShare)} testId="drive-share-link">
						<Link2 size={14} />
						{t("drive.shareLink")}
					</MenuRow>
					<MenuRow
						disabled={!hasFile}
						expanded={visibilityOpen}
						onClick={() => setVisibilityOpen((v) => !v)}
						testId="drive-edit-visibility"
					>
						<DriveIcon size={14} />
						{t("drive.editVisibility")}
					</MenuRow>
					{visibilityOpen ? (
						<div role="group" aria-label={t("drive.editVisibility")} style={{ paddingLeft: 22 }}>
							{VISIBILITIES.map((option) => (
								<button
									key={option.id}
									type="button"
									role="menuitemradio"
									aria-checked={state.visibility === option.id}
									data-testid={`drive-visibility-${option.id}`}
									onClick={run(() => {
										if (state.visibility !== option.id) onSetVisibility(option.id);
									})}
									style={menuRowStyle}
								>
									<span style={{ width: 14, display: "inline-flex" }}>
										{state.visibility === option.id ? <Check size={14} /> : null}
									</span>
									{t(option.labelKey)}
								</button>
							))}
						</div>
					) : null}
					<MenuRow onClick={run(onUnsync)} testId="drive-unsync">
						<Unlink size={14} />
						{t("drive.unsync")}
					</MenuRow>
				</div>
			) : null}
		</div>
	);
}

const menuRowStyle: React.CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: 8,
	width: "100%",
	padding: "7px 10px",
	border: "none",
	borderRadius: "var(--r-sm)",
	background: "transparent",
	color: "var(--fg)",
	font: "400 13px/1.3 var(--font-body)",
	textAlign: "left",
	cursor: "pointer",
};

function MenuRow({
	onClick,
	disabled,
	expanded,
	testId,
	children,
}: {
	onClick: () => void;
	disabled?: boolean;
	expanded?: boolean;
	testId: string;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			role="menuitem"
			data-testid={testId}
			disabled={disabled}
			aria-expanded={expanded}
			onClick={onClick}
			style={{
				...menuRowStyle,
				opacity: disabled ? 0.5 : 1,
				cursor: disabled ? "default" : "pointer",
			}}
		>
			{children}
		</button>
	);
}
