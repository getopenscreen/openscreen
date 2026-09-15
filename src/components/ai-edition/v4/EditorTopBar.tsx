import {
	Check,
	ChevronDown,
	Download,
	Film,
	FolderOpen,
	FolderPlus,
	Info,
	Keyboard,
	Languages,
	type LucideIcon,
	MonitorSmartphone,
	Moon,
	PanelLeft,
	RefreshCw,
	Save,
	Scissors,
	Sparkles,
	Sun,
} from "lucide-react";
import {
	type KeyboardEvent as ReactKeyboardEvent,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import logoMark from "@/assets/openscreen-mark.png";
import { useI18n, useScopedT } from "@/contexts/I18nContext";
import { useTheme } from "@/hooks/useTheme";
import type { Locale } from "@/i18n/config";
import { getAvailableLocales, getLocaleName, getLocaleShort } from "@/i18n/loader";
import { StylePresetsMenu } from "../StylePresetsMenu";
import styles from "./EditorShellV4.module.css";

export type EditorMode = "media" | "edit" | "rec";

export interface TopBarActions {
	openProject: () => void;
	newProject: () => void;
	save: () => void;
	export: () => void;
	openSettings: () => void;
	renameProject: (title: string) => void;
	toggleChat: () => void;
	openProviderSettings: () => void;
	showAbout: () => void;
	checkForUpdates: () => void;
}

interface EditorTopBarProps {
	mode: EditorMode;
	onModeChange: (mode: EditorMode) => void;
	projectTitle: string | null;
	dirty: boolean;
	canExport: boolean;
	chatOpen: boolean;
	actions: TopBarActions;
}

/* No tab invents a glyph: each wears the one its own stage already uses, so the
   tab and the screen it opens name the same thing. Film is what MediaStage
   stamps on every asset card, Scissors is V4Timeline's, and MonitorSmartphone is
   the source picker RecStage opens with. */
const MODES: Array<{ id: EditorMode; labelKey: string; Icon: LucideIcon }> = [
	{ id: "media", labelKey: "topbar.modes.media", Icon: Film },
	{ id: "edit", labelKey: "topbar.modes.edit", Icon: Scissors },
	{ id: "rec", labelKey: "topbar.modes.rec", Icon: MonitorSmartphone },
];

export function EditorTopBar({
	mode,
	onModeChange,
	projectTitle,
	dirty,
	canExport,
	chatOpen,
	actions,
}: EditorTopBarProps) {
	const { theme, toggle: toggleTheme } = useTheme();
	const t = useScopedT("editor");

	// ponytail: the left side panel only renders in "edit" mode (see
	// NewEditorShell body), so its toggle is meaningless in Media/Rec —
	// hide the button (and its separator) there to keep the topbar honest.
	const showChatToggle = mode === "edit";
	return (
		<header className={styles.topbar}>
			{/* Fixed-width slot: the toggle is Edit-only, and .topbarLead holds its
			    space in the other modes so nothing to the right moves. */}
			<span className={styles.topbarLead}>
				{showChatToggle ? (
					<>
						<button
							type="button"
							className={`${styles.iconBtn}${chatOpen ? ` ${styles.on}` : ""}`}
							title={t("topbar.toggleChatPanel")}
							aria-label={t("topbar.toggleChatPanel")}
							aria-pressed={chatOpen}
							onClick={actions.toggleChat}
						>
							<PanelLeft size={17} />
						</button>
						<span className={styles.sep} aria-hidden />
					</>
				) : null}
			</span>
			<AppMenu actions={actions} />
			<span className={styles.sep} aria-hidden />
			<ProjectNameField title={projectTitle} dirty={dirty} onRename={actions.renameProject} />
			<span className={styles.sep} aria-hidden />
			<button
				type="button"
				className={styles.iconBtn}
				title={t("topbar.openProject")}
				aria-label={t("topbar.openProject")}
				onClick={actions.openProject}
			>
				<FolderOpen size={16} />
			</button>
			<button
				type="button"
				className={styles.iconBtn}
				title={t("topbar.newProject")}
				aria-label={t("topbar.newProject")}
				onClick={actions.newProject}
			>
				<FolderPlus size={16} />
			</button>
			<button
				type="button"
				className={styles.iconBtn}
				title={t("topbar.saveProject")}
				aria-label={t("topbar.saveProject")}
				onClick={actions.save}
				style={{ position: "relative" }}
			>
				<Save size={16} />
				{dirty ? (
					<span
						aria-hidden
						style={{
							position: "absolute",
							top: 5,
							right: 5,
							width: 6,
							height: 6,
							borderRadius: "50%",
							background: "var(--warn)",
						}}
					/>
				) : null}
			</button>
			<span className={styles.sep} aria-hidden />

			<div className={styles.modeSwitch} role="tablist" aria-label={t("topbar.editorMode")}>
				{MODES.map(({ id, labelKey, Icon }) => (
					<button
						key={id}
						type="button"
						role="tab"
						aria-selected={mode === id}
						title={t(labelKey)}
						// Under 960px the label is hidden and the tab is its glyph alone, so the
						// name is spelled out here rather than left to fall back to `title` —
						// what a tab is called must not depend on the window width.
						aria-label={t(labelKey)}
						// Feeds the hidden bold copy that reserves the selected width — see
						// .modeSwitch button::before.
						data-label={t(labelKey)}
						onClick={() => onModeChange(id)}
					>
						<Icon size={13} className={styles.modeIcon} aria-hidden />
						<span className={styles.modeLabel}>{t(labelKey)}</span>
					</button>
				))}
			</div>

			{/* A preset is the whole look the right panel's panes edit — Composition, camera,
			    cursor — so its entry sits in the bar, reachable from every pane and mode,
			    rather than in any one pane's header. It stays on the project side of the
			    bar, ahead of the two app-wide preferences. */}
			<StylePresetsMenu />
			{/* Language and theme are the two app-wide preferences in this bar, so they
			    sit together at its right end rather than one of them being stranded
			    among the per-project file actions. .langMenu is anchored right:0, so
			    it opens leftwards from here and stays on screen. */}
			<LangButton />
			<button
				type="button"
				className={styles.iconBtn}
				title={theme === "dark" ? t("topbar.switchToLightTheme") : t("topbar.switchToDarkTheme")}
				aria-label={t("topbar.toggleTheme")}
				onClick={toggleTheme}
			>
				{theme === "dark" ? <Moon size={16} /> : <Sun size={16} />}
			</button>
			<button
				type="button"
				className={styles.exportBtn}
				title={t("topbar.export")}
				aria-label={t("topbar.export")}
				onClick={actions.export}
				disabled={!canExport}
			>
				<Download size={15} />
				<span className={styles.exportLabel}>{t("topbar.export")}</span>
			</button>
		</header>
	);
}

function ProjectNameField({
	title,
	dirty,
	onRename,
}: {
	title: string | null;
	dirty: boolean;
	onRename: (title: string) => void;
}) {
	const t = useScopedT("editor");
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(title ?? "");
	const unsavedId = useId();

	const startEditing = () => {
		setDraft(title ?? "");
		setEditing(true);
	};

	const commit = () => {
		setEditing(false);
		const next = draft.trim();
		if (next) onRename(next);
	};

	if (editing) {
		return (
			<input
				className={styles.projectNameInput}
				autoFocus
				value={draft}
				onFocus={(e) => e.currentTarget.select()}
				onChange={(e) => setDraft(e.target.value)}
				onBlur={commit}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						commit();
					} else if (e.key === "Escape") {
						setEditing(false);
					}
				}}
			/>
		);
	}

	// No project, nothing to be unsaved — and the button reads "No project" there,
	// which a marker beside it would contradict.
	const modified = dirty && title !== null;

	return (
		<>
			<button
				type="button"
				className={`${styles.ghostBtn} ${styles.projectNameBtn}`}
				aria-label={t("topbar.renameProject")}
				// Tied to the button rather than left loose beside it: a detached sibling is
				// read when the reader walks the bar and never when the button is focused,
				// which is the one moment the state is worth knowing.
				aria-describedby={modified ? unsavedId : undefined}
				// The label is truncated to keep the slot fixed, so the full name has to
				// stay reachable on hover.
				title={title ?? undefined}
				disabled={!title}
				onClick={startEditing}
			>
				<span className={styles.projectNameLabel}>{title ?? t("topbar.noProject")}</span>
				<span className={styles.projectDirtyDot} data-on={modified} aria-hidden />
			</button>
			{/* The marker above is decoration to a screen reader, and the button's
			    aria-label swallows anything nested in it, so the state is spelled out
			    here instead — the one piece of the old status badge worth keeping. */}
			{modified ? (
				<span id={unsavedId} className="sr-only">
					{t("topbar.unsaved")}
				</span>
			) : null}
		</>
	);
}

/** The brand doubles as the application menu.
 *
 *  Windows and Linux have no visible menu bar to put About and the update check in: this bar
 *  IS the titlebar (createEditorWindow passes titleBarStyle:"hidden"), and the native menu is
 *  behind setAutoHideMenuBar(true) — so those two items were reachable only from the tray, or
 *  by holding Alt, which is to say not reachable. Hanging them off the wordmark is what Figma,
 *  Linear and Slack do under the same constraint.
 *
 *  It costs the bar no width, which is the reason it is the wordmark and not a new button:
 *  .modeSwitch is the only flex-shrink:1 element in the topbar, so any control added here is
 *  paid for out of the mode labels, in the most verbose of 13 locales, at the 800px minimum
 *  window width.
 *
 *  No row invents a label. Each one reuses the key of the thing it opens: `common.actions.*`
 *  for the rows electron/main.ts also builds native menu items from (About, Check for
 *  Updates), and the dialog's own title key for the rows that open a dialog (`shortcuts.title`,
 *  `editor.providerSettings.title`). That is what stops this menu from drifting away from the
 *  native menu on one side and from what its rows actually open on the other — and it is why
 *  this component adds no translation work. */
/** Shared by the mount seed and the per-open refresh below. A rejection — no preload, browser
 *  mode — resolves to "no", which hides the item rather than shipping a button whose click the
 *  main process would refuse without saying so. */
async function readUpdateVeto(cancelled: () => boolean, apply: (allowed: boolean) => void) {
	try {
		const allowed = await window.electronAPI?.canCheckForUpdatesNow?.();
		if (!cancelled()) apply(allowed === true);
	} catch {
		if (!cancelled()) apply(false);
	}
}

function AppMenu({ actions }: { actions: TopBarActions }) {
	const tCommon = useScopedT("common");
	const tEditor = useScopedT("editor");
	const tShortcuts = useScopedT("shortcuts");
	const [open, setOpen] = useState(false);
	const [version, setVersion] = useState<string | null>(null);
	const [canUpdate, setCanUpdate] = useState(false);
	const ref = useRef<HTMLDivElement | null>(null);
	const menuRef = useRef<HTMLDivElement | null>(null);
	const triggerRef = useRef<HTMLButtonElement | null>(null);

	// At mount: the version, which never changes while the process lives, and a first read of
	// the update veto so the item does not pop in a frame late on the first open and shove the
	// row under the pointer.
	useEffect(() => {
		let cancelled = false;
		window.electronAPI
			?.getAppInfo?.()
			.then((info) => {
				if (!cancelled) setVersion(info.version);
			})
			.catch(() => {
				// Leaves the version off the About row. The row itself still works, and the tray
				// and native menu still reach the same box, so there is nothing to report.
			});
		void readUpdateVeto(() => cancelled, setCanUpdate);
		return () => {
			cancelled = true;
		};
	}, []);

	// And again on every open, unlike the version: this answer includes the transient veto —
	// no update check mid-take — so the seed above goes stale the moment a recording starts.
	// A cached "yes" would offer a check that the main process then silently refuses.
	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		void readUpdateVeto(() => cancelled, setCanUpdate);
		return () => {
			cancelled = true;
		};
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const onDocMouseDown = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
		};
		document.addEventListener("mousedown", onDocMouseDown);
		return () => document.removeEventListener("mousedown", onDocMouseDown);
	}, [open]);

	// Focus the first item as the menu appears, so it is operable from the keyboard without a
	// Tab through the whole bar first.
	useEffect(() => {
		if (!open) return;
		menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
	}, [open]);

	const close = (restoreFocus: boolean) => {
		setOpen(false);
		// Escape and Tab-out hand focus back to the trigger; a click does not, because the
		// pointer user did not come from there and a focus ring appearing under the cursor
		// reads as a bug.
		if (restoreFocus) triggerRef.current?.focus();
	};

	const onMenuKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
		if (e.key === "Escape") {
			e.preventDefault();
			close(true);
			return;
		}
		if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
		e.preventDefault();
		const items = Array.from(
			menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
		);
		if (items.length === 0) return;
		const at = items.indexOf(document.activeElement as HTMLButtonElement);
		const next = e.key === "ArrowDown" ? at + 1 : at - 1;
		// Wraps both ways; `at` is -1 when focus escaped the list, and ArrowDown then lands on 0.
		items[(next + items.length) % items.length]?.focus();
	};

	const run = (action: () => void) => () => {
		close(false);
		action();
	};

	return (
		<div ref={ref} className={styles.appMenuAnchor}>
			<button
				ref={triggerRef}
				type="button"
				className={`${styles.brand} ${styles.brandBtn}`}
				aria-haspopup="menu"
				aria-expanded={open}
				aria-label="OpenScreen"
				title="OpenScreen"
				onClick={() => setOpen((v) => !v)}
			>
				{/* Decorative: the wordmark beside it already names the app — and, being the
				    button's only text, is also its accessible name. */}
				<img src={logoMark} alt="" draggable={false} />
				<span className={styles.name}>OpenScreen</span>
				<ChevronDown size={13} className={styles.brandChevron} aria-hidden />
			</button>
			{open ? (
				<div ref={menuRef} className={styles.appMenu} role="menu" onKeyDown={onMenuKeyDown}>
					<button
						type="button"
						role="menuitem"
						className={styles.appMenuRow}
						onClick={run(actions.openSettings)}
					>
						<Keyboard size={15} />
						{tShortcuts("title")}
					</button>
					{/* Settings surfaces together, above the separator. Both rows are labelled with the
					    title of the dialog they open, so neither can drift from it — and unlike the AI
					    panel's own entry points, this one is reachable in Media and Rec too, which is
					    the whole reason the dialog's open state was lifted out of LeftPanel (#420). */}
					<button
						type="button"
						role="menuitem"
						className={styles.appMenuRow}
						onClick={run(actions.openProviderSettings)}
					>
						<Sparkles size={15} />
						{tEditor("providerSettings.title")}
					</button>
					<div className={styles.appMenuSep} aria-hidden />
					{/* Only the PERMANENT half of the veto is applied here. A Store/Flathub/Snap/Nix
					    copy never offers the check at all; the transient half — not during a take —
					    stays with the main process, which re-checks it on the IPC, because this
					    window is not the one that knows a recording is running. */}
					{canUpdate ? (
						<button
							type="button"
							role="menuitem"
							className={styles.appMenuRow}
							onClick={run(actions.checkForUpdates)}
						>
							<RefreshCw size={15} />
							{tCommon("actions.checkForUpdates")}
						</button>
					) : null}
					<button
						type="button"
						role="menuitem"
						className={styles.appMenuRow}
						onClick={run(actions.showAbout)}
					>
						<Info size={15} />
						{tCommon("actions.about")}
						{version ? <span className={styles.appMenuVersion}>{version}</span> : null}
					</button>
				</div>
			) : null}
		</div>
	);
}

/** The bar's one settings menu that is not the app menu.
 *
 *  It was a click-only popover: no Escape, no arrow keys, no focus to return to, and
 *  `aria-pressed` on a control that opens a menu rather than toggling a state. The
 *  app menu twenty lines up already does all of this properly, so this follows it
 *  rather than inventing a second set of manners for the same gesture.
 *
 *  The list is thirteen entries in eleven scripts, which shapes two decisions below:
 *  the keyboard opens onto the language you are already in rather than the top of
 *  the list, and typeahead matches the locale code as well as the native name —
 *  nobody reaches 日本語 by typing its own name on a Latin keyboard. */
function LangButton() {
	const { locale, setLocale } = useI18n();
	const t = useScopedT("editor");
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement | null>(null);
	const menuRef = useRef<HTMLDivElement | null>(null);
	const triggerRef = useRef<HTMLButtonElement | null>(null);
	// Stable across renders so it can be a dependency below without re-firing.
	const locales = useMemo(() => getAvailableLocales(), []);
	const typeahead = useRef({ buffer: "", at: 0 });

	useEffect(() => {
		if (!open) return;
		const onDocClick = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
		};
		document.addEventListener("mousedown", onDocClick);
		return () => document.removeEventListener("mousedown", onDocClick);
	}, [open]);

	// Land on the current language, not on the top of the list: opening the menu
	// should show you where you are, and it makes escaping a mis-click free.
	useEffect(() => {
		if (!open) return;
		const items = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]');
		const at = locales.indexOf(locale);
		items?.[at >= 0 ? at : 0]?.focus();
	}, [open, locale, locales]);

	const close = (restoreFocus: boolean) => {
		setOpen(false);
		// Escape and a pick hand focus back to the trigger; a click does not, because
		// the pointer user did not come from there and a ring appearing under the
		// cursor reads as a bug.
		if (restoreFocus) triggerRef.current?.focus();
	};

	const itemsInMenu = () =>
		Array.from(
			menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [],
		);

	const onMenuKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
		if (e.key === "Escape") {
			e.preventDefault();
			close(true);
			return;
		}
		// Tabbing out is a legitimate way to leave; closing without stealing focus
		// back lets it land wherever Tab was going.
		if (e.key === "Tab") {
			setOpen(false);
			return;
		}
		const list = itemsInMenu();
		if (list.length === 0) return;
		const at = list.indexOf(document.activeElement as HTMLButtonElement);
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			const next = e.key === "ArrowDown" ? at + 1 : at - 1;
			// Wraps both ways; `at` is -1 when focus escaped the list, and ArrowDown
			// then lands on 0.
			list[(next + list.length) % list.length]?.focus();
			return;
		}
		if (e.key === "Home" || e.key === "End") {
			e.preventDefault();
			(e.key === "Home" ? list[0] : list[list.length - 1])?.focus();
			return;
		}
		if (e.key.length !== 1 || e.metaKey || e.ctrlKey || e.altKey) return;
		const now = Date.now();
		const buffer = now - typeahead.current.at < 600 ? typeahead.current.buffer + e.key : e.key;
		typeahead.current = { buffer, at: now };
		const needle = buffer.toLowerCase();
		// The code as well as the name: "Français" is reachable by typing it, 日本語
		// is not, and "ja" is what a Latin keyboard can actually produce.
		const hit = locales.findIndex(
			(code) =>
				getLocaleName(code).toLowerCase().startsWith(needle) ||
				code.toLowerCase().startsWith(needle),
		);
		if (hit >= 0) {
			e.preventDefault();
			list[hit]?.focus();
		}
	};

	const choose = (code: Locale) => {
		setLocale(code);
		close(true);
	};

	return (
		<div ref={ref} className={styles.langAnchor}>
			<button
				ref={triggerRef}
				type="button"
				className={`${styles.iconBtn} ${styles.langBtn}`}
				onClick={() => setOpen((v) => !v)}
				onKeyDown={(e) => {
					if (e.key === "ArrowDown" && !open) {
						e.preventDefault();
						setOpen(true);
					}
				}}
				aria-haspopup="menu"
				aria-expanded={open}
				aria-label={t("topbar.changeLanguage")}
			>
				<Languages size={15} className={styles.langIcon} aria-hidden />
				{/* Fixed-width, centred: the short labels run from "EN" to "PT-BR" to
				    the CJK "简中", and letting the button size to them moved everything
				    to its right on each language change. */}
				<span className={styles.langShort}>{getLocaleShort(locale)}</span>
				<ChevronDown size={9} className={styles.langChevron} aria-hidden />
			</button>
			{open ? (
				<div
					ref={menuRef}
					className={styles.langMenu}
					role="menu"
					aria-label={t("topbar.changeLanguage")}
					onKeyDown={onMenuKeyDown}
				>
					{locales.map((code) => {
						const active = code === locale;
						return (
							<button
								key={code}
								type="button"
								role="menuitemradio"
								aria-checked={active}
								className={styles.langMenuItem}
								data-active={active}
								onClick={() => choose(code)}
							>
								{/* The tick, not the colour, is what says "this one". The gutter is
								    always there so the names stay on one left edge. */}
								<span className={styles.langMenuCheck} aria-hidden>
									{active ? <Check size={13} /> : null}
								</span>
								{getLocaleName(code)}
							</button>
						);
					})}
				</div>
			) : null}
		</div>
	);
}
