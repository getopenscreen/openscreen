import { X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useScopedT } from "@/contexts/I18nContext";
import { Button } from "../ui/button";
import { TOAST_DURATION_MS } from "../ui/sonner";
import { HudLanguageMenu, HudNotice } from "./HudControls";
import { HudDeviceSettings } from "./HudDeviceSettings";
import { HUD_MODAL_MAX_HEIGHT, HUD_POPOVER_MAX_HEIGHT } from "./hudGeometry";
import {
	EMPTY_HUD_PANEL_STATE,
	type HudPanelAction,
	type HudPanelState,
	type HudPanelToast,
} from "./hudPanel";
import styles from "./LaunchWindow.module.css";

/** Padding around the stack, so the cards' rounded corners keep clear of the window edge. */
const PANEL_PADDING = 10;
const send = (action: HudPanelAction) => window.electronAPI?.sendHudPanelAction?.(action);
const noop = () => undefined;

/**
 * One mirrored toast. The HUD owns the toast (sonner's store); this card owns its timer,
 * since the HUD mounts no toaster on Linux to run one, and reports the dismissal back.
 */
function HudPanelToastCard({ toast }: { toast: HudPanelToast }) {
	const tc = useScopedT("common");
	const { id, duration, type } = toast;
	useEffect(() => {
		if (type === "loading") return;
		const ms = duration ?? TOAST_DURATION_MS;
		if (!Number.isFinite(ms)) return;
		const timer = window.setTimeout(() => send({ kind: "toast-dismiss", id }), ms);
		return () => window.clearTimeout(timer);
	}, [id, duration, type]);

	const accent =
		type === "error"
			? "border-l-[#ef4444]"
			: type === "warning"
				? "border-l-[#f59e0b]"
				: type === "success"
					? "border-l-[#10b981]"
					: "border-l-white/20";

	return (
		<div
			role={type === "error" ? "alert" : "status"}
			data-testid="hud-panel-toast"
			className={`${styles.hudNotice} w-full border-l-4 ${accent} p-3 text-white`}
		>
			<div className="flex items-start gap-2">
				<div className="min-w-0 flex-1">
					<div className="text-[13.5px] font-semibold text-white">{toast.title}</div>
					{toast.description && (
						<div className="mt-1 text-[12.5px] leading-relaxed text-white/75">
							{toast.description}
						</div>
					)}
				</div>
				<button
					type="button"
					aria-label={tc("actions.closeNotification")}
					onClick={() => send({ kind: "toast-dismiss", id })}
					className="rounded-md p-1 text-white/60 hover:bg-white/10 hover:text-white"
				>
					<X size={14} />
				</button>
			</div>
			{toast.actionLabel && (
				<div className="mt-2 flex justify-end">
					<Button
						type="button"
						size="sm"
						onClick={() => send({ kind: "toast-action", id })}
						className="h-8 rounded-[9px] bg-[#10b981] text-[13px] font-semibold text-[#08090d] hover:bg-[#10b981]/85"
					>
						{toast.actionLabel}
					</Button>
				</div>
			)}
		</div>
	);
}

/**
 * The Linux HUD's floating surfaces, in their own window: see hudPanel.ts for why. A view
 * of the snapshot the HUD sends, with every control wired back to the HUD as an action.
 */
export function HudPanelWindow() {
	const [state, setState] = useState<HudPanelState>(EMPTY_HUD_PANEL_STATE);
	const rootRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		const unsubscribe = window.electronAPI?.onHudPanelState?.(setState);
		window.electronAPI?.requestHudPanelState?.();
		return unsubscribe;
	}, []);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") send({ kind: "close-popovers" });
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);

	// The window is sized to the stack, so it is never bigger than what it shows.
	const reportSize = useCallback(() => {
		const root = rootRef.current;
		if (!root) return;
		const { width, height } = root.getBoundingClientRect();
		if (width > 0 && height > 0) {
			window.electronAPI?.setHudPanelSize?.(Math.ceil(width), Math.ceil(height));
		}
	}, []);
	useLayoutEffect(() => {
		const root = rootRef.current;
		if (!root) return;
		const observer = new ResizeObserver(reportSize);
		observer.observe(root);
		reportSize();
		return () => observer.disconnect();
	}, [reportSize]);
	// Also on every snapshot: a hidden panel is shown again by its next size report, and
	// content of the same size as last time would otherwise never send one.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `state` is the trigger, not an input.
	useLayoutEffect(() => reportSize(), [state, reportSize]);

	const { deviceSettings, languageMenu, notices, toasts } = state;
	const names = languageMenu?.names;
	const getName = useCallback((locale: string) => names?.[locale] ?? locale, [names]);

	return (
		<div
			ref={rootRef}
			data-testid="hud-panel"
			className="flex w-max flex-col items-stretch gap-[10px]"
			style={
				{
					padding: PANEL_PADDING,
					"--hud-popover-max-h": `${HUD_POPOVER_MAX_HEIGHT}px`,
					"--hud-modal-max-h": `${HUD_MODAL_MAX_HEIGHT}px`,
				} as React.CSSProperties
			}
		>
			{deviceSettings && (
				<HudDeviceSettings
					{...deviceSettings}
					onSelectCameraQuality={(quality) => send({ kind: "select-camera-quality", quality })}
					onSelectMic={(device) => send({ kind: "select-mic", device })}
					onSelectCamera={(device) => send({ kind: "select-camera", device })}
					onCheckForUpdates={() => send({ kind: "check-for-updates" })}
					onClose={() => send({ kind: "close-device-settings" })}
					panelRef={noop}
				/>
			)}
			{languageMenu && (
				<HudLanguageMenu
					locales={languageMenu.locales}
					activeLocale={languageMenu.activeLocale}
					getName={getName}
					onSelect={(locale) => send({ kind: "select-locale", locale })}
					panelRef={noop}
					onEnsureInteractive={noop}
				/>
			)}
			{notices.map((notice) => (
				<HudNotice
					key={notice.id}
					title={notice.title}
					description={notice.description}
					dismissLabel={notice.dismissLabel}
					confirmLabel={notice.confirmLabel}
					onDismiss={() => send({ kind: "notice", id: notice.id, choice: "dismiss" })}
					onConfirm={() => send({ kind: "notice", id: notice.id, choice: "confirm" })}
				/>
			))}
			{toasts.map((toast) => (
				// Keyed on the content too, so a toast replaced under the same id gets a fresh
				// timer, as sonner gives it; an unchanged snapshot keeps the card and its timer.
				<HudPanelToastCard
					key={`${toast.id}\u0000${toast.title}\u0000${toast.description ?? ""}`}
					toast={toast}
				/>
			))}
		</div>
	);
}
