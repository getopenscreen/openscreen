import { Accessibility, Check, Mic, MonitorPlay, Video, Volume2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useScopedT } from "@/contexts/I18nContext";

type PermissionsApi = Window["electronAPI"]["permissions"];
type Snapshot = Awaited<ReturnType<PermissionsApi["get"]>>;
type Kind = Parameters<PermissionsApi["request"]>[0];
type Status = Snapshot["screen"];

/**
 * How often the statuses are re-read while the window is open. The user changes them in
 * System Settings, which tells no one, so polling is the only way to follow along; each
 * Screen Recording read spawns a short-lived helper, which is cheap at this rate.
 */
export const PERMISSIONS_POLL_MS = 500;

type Row = {
	kind: Kind;
	level: "required" | "recommended" | "optional";
	Icon: typeof MonitorPlay;
};

const OTHER_ROWS: readonly Row[] = [
	{ kind: "accessibility", level: "recommended", Icon: Accessibility },
	{ kind: "microphone", level: "optional", Icon: Mic },
	{ kind: "camera", level: "optional", Icon: Video },
];

/**
 * With the app's own picker, Screen Recording is required and also covers system audio.
 * With Apple's picker (macOS 15.2+) nothing is required: the pick is the consent, and
 * system audio comes from a Core Audio tap under its own, optional grant.
 */
function rowsFor(snapshot: Snapshot): readonly Row[] {
	const first: Row = snapshot.screenRequired
		? { kind: "screen", level: "required", Icon: MonitorPlay }
		: { kind: "systemAudio", level: "optional", Icon: Volume2 };
	return [first, ...OTHER_ROWS];
}

/**
 * From macOS 15, any app that uses ScreenCaptureKit outside Apple's system picker gets an
 * alert asking whether it may "bypass the system private window picker", on top of the
 * Screen Recording grant and again periodically. It cannot be raised on demand (replayd
 * shows it on its own schedule, whatever the last answer was), and its approval cannot be
 * read, so it cannot be a row with a status. What the window can do is say it is coming,
 * and which button to press, before the first recording meets it.
 */
const RECURRING_SCREEN_ALERT_FROM_MACOS = 15;

export function PermissionsWindow() {
	const t = useScopedT("launch");
	const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
	const [busy, setBusy] = useState<Kind | null>(null);
	const mounted = useRef(true);

	const refresh = useCallback(async () => {
		try {
			const next = await window.electronAPI.permissions.get();
			if (mounted.current) {
				setSnapshot(next);
			}
		} catch (error) {
			console.warn("[permissions] read failed:", error);
		}
	}, []);

	useEffect(() => {
		mounted.current = true;
		let timer: number | undefined;
		// Sequential rather than setInterval: a slow read must not stack up behind itself.
		const tick = async () => {
			await refresh();
			if (mounted.current) {
				timer = window.setTimeout(tick, PERMISSIONS_POLL_MS);
			}
		};
		void tick();
		return () => {
			mounted.current = false;
			window.clearTimeout(timer);
		};
	}, [refresh]);

	const act = useCallback(
		async (kind: Kind, status: Status) => {
			setBusy(kind);
			try {
				if (status === "denied" || status === "requested") {
					await window.electronAPI.permissions.openSettings(kind);
				} else {
					await window.electronAPI.permissions.request(kind);
				}
				await refresh();
			} finally {
				if (mounted.current) {
					setBusy(null);
				}
			}
		},
		[refresh],
	);

	if (!snapshot) {
		return <div className="h-screen bg-[#0b0c0f]" />;
	}

	const screenReady =
		!snapshot.screenRequired || (snapshot.screen === "granted" && !snapshot.screenRequiresRelaunch);
	const needsRelaunch = snapshot.screen === "granted" && snapshot.screenRequiresRelaunch;

	return (
		<div className="flex h-screen flex-col bg-[#0b0c0f] px-7 pt-7 pb-6 text-white select-none">
			<h1 className="text-[17px] font-semibold">{t("permissions.title")}</h1>
			<p className="mt-1.5 text-[13px] leading-5 text-[#8b93a1]">{t("permissions.subtitle")}</p>

			<ul className="mt-5 flex flex-col gap-2.5">
				{rowsFor(snapshot).map(({ kind, level, Icon }) => {
					const status = snapshot[kind];
					return (
						<li
							key={kind}
							data-testid={`permission-${kind}`}
							data-status={status}
							className="rounded-xl border border-[#20232a] bg-[#121419] px-4 py-3"
						>
							<div className="flex items-center gap-3">
								<Icon className="h-5 w-5 shrink-0 text-[#10b981]" aria-hidden />
								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-2">
										<span className="text-[13px] font-medium">
											{t(`permissions.rows.${kind}.name`)}
										</span>
										<span className="rounded-full bg-[#1c1f26] px-2 py-px text-[11px] text-[#8b93a1]">
											{t(`permissions.level.${level}`)}
										</span>
									</div>
									<p className="mt-0.5 text-[12.5px] leading-[18px] text-[#8b93a1]">
										{t(`permissions.rows.${kind}.description`)}
									</p>
								</div>
								<PermissionAction
									kind={kind}
									status={status}
									busy={busy === kind}
									onAct={() => void act(kind, status)}
									t={t}
								/>
							</div>
							{kind === "screen" && (
								<ScreenHelp snapshot={snapshot} needsRelaunch={needsRelaunch} t={t} />
							)}
							{kind === "systemAudio" && <SystemAudioHelp status={status} t={t} />}
						</li>
					);
				})}
			</ul>

			<div className="mt-auto flex items-center justify-between gap-4 pt-5">
				<p className="text-[12.5px] leading-[18px] text-[#8b93a1]">
					{screenReady ? t("permissions.footer.ready") : t("permissions.footer.screenRequired")}
				</p>
				{needsRelaunch ? (
					<button
						type="button"
						data-testid="permissions-relaunch"
						onClick={() => void window.electronAPI.permissions.relaunch()}
						className="h-9 shrink-0 rounded-[9px] bg-[#10b981] px-5 text-[13px] font-semibold text-[#08090d] hover:bg-[#10b981]/85"
					>
						{t("permissions.actions.restart")}
					</button>
				) : (
					<button
						type="button"
						data-testid="permissions-start"
						disabled={!screenReady}
						onClick={() => void window.electronAPI.permissions.close()}
						className="h-9 shrink-0 rounded-[9px] bg-[#10b981] px-5 text-[13px] font-semibold text-[#08090d] hover:bg-[#10b981]/85 disabled:cursor-not-allowed disabled:opacity-50"
					>
						{t("permissions.actions.start")}
					</button>
				)}
			</div>
		</div>
	);
}

type T = ReturnType<typeof useScopedT>;

function PermissionAction({
	kind,
	status,
	busy,
	onAct,
	t,
}: {
	kind: Kind;
	status: Status;
	busy: boolean;
	onAct: () => void;
	t: T;
}) {
	if (status === "granted") {
		return (
			<span className="flex shrink-0 items-center gap-1 text-[13px] font-medium text-[#10b981]">
				<Check className="h-4 w-4" aria-hidden />
				{t("permissions.status.granted")}
			</span>
		);
	}
	if (status === "restricted") {
		return (
			<span className="max-w-[120px] shrink-0 text-right text-[12.5px] leading-[18px] text-[#8b93a1]">
				{t("permissions.status.restricted")}
			</span>
		);
	}

	// Screen Recording's first step says "Continue", not "Allow": macOS' own prompt has no
	// Allow button, only a way into System Settings, and the label must not promise one.
	// `requested` is system audio's "asked, answer unknown": all that is left to offer is the
	// pane where the answer can be changed.
	const label =
		status === "denied" || status === "requested"
			? t("permissions.actions.openSettings")
			: kind === "screen"
				? t("permissions.actions.continue")
				: t("permissions.actions.allow");

	return (
		<button
			type="button"
			data-testid={`permission-${kind}-action`}
			disabled={busy}
			onClick={onAct}
			className="h-8 shrink-0 rounded-[8px] bg-[#1f232b] px-3.5 text-[13px] font-medium text-white hover:bg-[#2a2f39] disabled:opacity-50"
		>
			{label}
		</button>
	);
}

function ScreenHelp({
	snapshot,
	needsRelaunch,
	t,
}: {
	snapshot: Snapshot;
	needsRelaunch: boolean;
	t: T;
}) {
	const lines: string[] = [];
	if (needsRelaunch) {
		lines.push(t("permissions.help.screenRestart"));
	} else if (snapshot.screen === "denied") {
		lines.push(t("permissions.help.screenSettings"), t("permissions.help.screenNotListed"));
	} else if (snapshot.screen === "not-requested") {
		lines.push(t("permissions.help.screenPrompt"));
	}
	// Captures started from Apple's picker never raise that alert, so there is nothing to
	// warn about when the picker owns the choice.
	if (
		snapshot.screenRequired &&
		snapshot.screen === "granted" &&
		snapshot.macosMajor >= RECURRING_SCREEN_ALERT_FROM_MACOS
	) {
		lines.push(t("permissions.help.screenRecurring"));
	}
	if (lines.length === 0) {
		return null;
	}
	return (
		<div className="mt-2.5 space-y-1 border-t border-[#20232a] pt-2.5 pl-8">
			{lines.map((line) => (
				<p key={line} className="text-[12.5px] leading-[18px] text-[#a9b0bc]">
					{line}
				</p>
			))}
		</div>
	);
}

function SystemAudioHelp({ status, t }: { status: Status; t: T }) {
	const line =
		status === "not-requested"
			? t("permissions.help.systemAudioPrompt")
			: status === "requested"
				? t("permissions.help.systemAudioRequested")
				: null;
	if (!line) {
		return null;
	}
	return (
		<div className="mt-2.5 border-t border-[#20232a] pt-2.5 pl-8">
			<p className="text-[12.5px] leading-[18px] text-[#a9b0bc]">{line}</p>
		</div>
	);
}
