// The editor top bar's "Presets" menu: apply, save and manage editor style presets.
//
// A preset is a file on disk (see src/lib/ai-edition/stylePresets.ts), so everything but
// applying one goes through `nativeBridgeClient.presets`. Applying is a single
// `useEditorSettings().set(patch)`, so one Ctrl+Z takes the whole look back.
//
// Secondary actions (reveal, rename, update, delete) open INLINE under their row rather
// than in a nested popover: a second Radix layer inside this one would fight it for
// Escape and outside-click, and a row of plain buttons stays reachable with Tab.

import { Check, Loader2, MoreHorizontal, SwatchBook } from "lucide-react";
import { type KeyboardEvent, useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useScopedT } from "@/contexts/I18nContext";
import { getEditorSettings, patchEditorSettings } from "@/lib/ai-edition/store/editorSettings";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { useEditorSettings } from "@/lib/ai-edition/store/useEditorSettings";
import {
	FACTORY_STYLE_PRESET_ID,
	type StylePreset,
	type StylePresetAppearance,
	sanitizeStylePresetName,
} from "@/lib/ai-edition/stylePresets";
import {
	factoryStylePresetAppearance,
	stylePresetAppearanceFromSettings,
	stylePresetPatch,
} from "@/lib/ai-edition/stylePresetsEditor";
import {
	isNativeCompositorActive,
	isStylePresetNameTakenError,
	nativeBridgeClient,
	pushAllNativeParams,
} from "@/native";
import { getPlatform } from "@/utils/platformUtils";
import styles from "./NewEditorShell.module.css";
import topbarStyles from "./v4/EditorShellV4.module.css";

/** Structural equality over plain JSON-shaped values. A preset read from disk carries its
 *  keys in file order, so a key-order-sensitive comparison would never light a row. */
function sameValue(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	const aKeys = Object.keys(a);
	const bKeys = Object.keys(b);
	if (aKeys.length !== bKeys.length) return false;
	return aKeys.every((key) =>
		sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function revealLabelKey():
	| "stylePresets.revealMac"
	| "stylePresets.revealWindows"
	| "stylePresets.revealLinux" {
	const platform = getPlatform();
	if (platform === "darwin") return "stylePresets.revealMac";
	if (platform === "win32") return "stylePresets.revealWindows";
	return "stylePresets.revealLinux";
}

/** What the menu is in the middle of. Only one inline editor exists at a time. */
type MenuMode =
	| { kind: "idle" }
	| { kind: "create" }
	| { kind: "rename"; id: string }
	| { kind: "confirmDelete"; id: string };

const IDLE: MenuMode = { kind: "idle" };

interface NameFormProps {
	initialName: string;
	placeholder: string;
	saveLabel: string;
	cancelLabel: string;
	error: string | null;
	busy: boolean;
	onSubmit: (name: string) => void;
	onCancel: () => void;
}

function NameForm({
	initialName,
	placeholder,
	saveLabel,
	cancelLabel,
	error,
	busy,
	onSubmit,
	onCancel,
}: NameFormProps) {
	const [name, setName] = useState(initialName);
	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Enter" && !busy) {
			event.preventDefault();
			onSubmit(name);
		}
		// Escape is handled by the popover's `onEscapeKeyDown`, which sees it first.
	};
	return (
		<div className={styles.presetForm}>
			<input
				type="text"
				disabled={busy}
				autoFocus
				value={name}
				placeholder={placeholder}
				aria-label={placeholder}
				aria-invalid={error ? true : undefined}
				onChange={(event) => setName(event.target.value)}
				onKeyDown={onKeyDown}
			/>
			{error ? (
				<div className={styles.presetError} role="alert">
					{error}
				</div>
			) : null}
			<div className={styles.presetFormButtons}>
				<button type="button" className={styles.rowAction} onClick={onCancel}>
					{cancelLabel}
				</button>
				<button
					type="button"
					className={styles.rowAction}
					disabled={busy}
					onClick={() => onSubmit(name)}
				>
					{saveLabel}
				</button>
			</div>
		</div>
	);
}

export function StylePresetsMenu() {
	const ts = useScopedT("settings");
	const tc = useScopedT("common");
	const { settings, set, hasDocument } = useEditorSettings();

	const [open, setOpen] = useState(false);
	const [presets, setPresets] = useState<StylePreset[]>([]);
	const [loading, setLoading] = useState(false);
	const [loadFailed, setLoadFailed] = useState(false);
	const [mode, setMode] = useState<MenuMode>(IDLE);
	const [expandedId, setExpandedId] = useState<string | null>(null);
	const [formError, setFormError] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	// A slow `list` from an earlier opening must not overwrite a newer one.
	const loadSeq = useRef(0);

	const refresh = useCallback(async () => {
		const seq = ++loadSeq.current;
		setLoading(true);
		try {
			const next = await nativeBridgeClient.presets.list();
			if (seq !== loadSeq.current) return;
			setPresets(next);
			setLoadFailed(false);
		} catch {
			if (seq !== loadSeq.current) return;
			setLoadFailed(true);
		} finally {
			if (seq === loadSeq.current) setLoading(false);
		}
	}, []);

	const resetInline = () => {
		setMode(IDLE);
		setFormError(null);
		setActionError(null);
		setBusy(false);
	};

	const onOpenChange = (next: boolean) => {
		setOpen(next);
		if (next) {
			resetInline();
			setExpandedId(null);
			void refresh();
		}
	};

	const current = stylePresetAppearanceFromSettings(settings);
	const factory = factoryStylePresetAppearance();

	const apply = async (appearance: StylePresetAppearance, name: string) => {
		setOpen(false);
		const patch = stylePresetPatch(appearance);
		if (!(await set(patch))) return;
		// The overlay only pushes native params on mount, and each control here pushes its own
		// diff; a preset touches all of them at once, so it pushes the whole resulting snapshot.
		const doc = useProjectStore.getState().document;
		if (doc && isNativeCompositorActive()) {
			pushAllNativeParams(getEditorSettings(patchEditorSettings(doc, patch)));
		}
		toast.success(ts("stylePresets.applied", { name }));
	};

	const validName = (raw: string): string | null => {
		try {
			return sanitizeStylePresetName(raw);
		} catch {
			setFormError(ts("stylePresets.nameRequired"));
			return null;
		}
	};

	const saveFailure = (error: unknown) =>
		isStylePresetNameTakenError(error)
			? ts("stylePresets.nameTaken")
			: ts("stylePresets.saveFailed", { error: errorMessage(error) });

	const submitCreate = async (raw: string) => {
		const name = validName(raw);
		if (!name) return;
		setBusy(true);
		try {
			await nativeBridgeClient.presets.create(name, current);
			resetInline();
			toast.success(ts("stylePresets.saved"));
			await refresh();
		} catch (error) {
			setFormError(saveFailure(error));
			setBusy(false);
		}
	};

	const submitRename = async (id: string, raw: string) => {
		const name = validName(raw);
		if (!name) return;
		setBusy(true);
		try {
			await nativeBridgeClient.presets.rename(id, name);
			resetInline();
			setExpandedId(null);
			await refresh();
		} catch (error) {
			setFormError(saveFailure(error));
			setBusy(false);
		}
	};

	const runUpdate = async (id: string) => {
		setActionError(null);
		setBusy(true);
		try {
			await nativeBridgeClient.presets.update(id, current);
			setExpandedId(null);
			toast.success(ts("stylePresets.updated"));
			await refresh();
		} catch (error) {
			setActionError(ts("stylePresets.saveFailed", { error: errorMessage(error) }));
		} finally {
			setBusy(false);
		}
	};

	const runDelete = async (id: string) => {
		setActionError(null);
		setBusy(true);
		try {
			await nativeBridgeClient.presets.delete(id);
			resetInline();
			setExpandedId(null);
			await refresh();
		} catch (error) {
			setActionError(errorMessage(error));
			setBusy(false);
		}
	};

	const runReveal = async (id: string) => {
		setActionError(null);
		try {
			await nativeBridgeClient.presets.reveal(id);
		} catch (error) {
			setActionError(errorMessage(error));
		}
	};

	const rowClass = (active: boolean) =>
		`${styles.actionMenuRow}${active ? ` ${styles.isActive}` : ""}`;

	const actionRow = (label: string, onClick: () => void) => (
		<button
			type="button"
			role="menuitem"
			className={styles.actionMenuRow}
			disabled={busy}
			onClick={onClick}
		>
			<span className={styles.presetActionLabel}>{label}</span>
		</button>
	);

	const renderUserPreset = (preset: StylePreset) => {
		const active = sameValue(preset.appearance, current);
		const expanded = expandedId === preset.id;
		const renaming = mode.kind === "rename" && mode.id === preset.id;
		const confirmingDelete = mode.kind === "confirmDelete" && mode.id === preset.id;
		return (
			<div key={preset.id}>
				{renaming ? (
					<NameForm
						initialName={preset.name}
						placeholder={ts("stylePresets.namePlaceholder")}
						saveLabel={ts("stylePresets.save")}
						cancelLabel={tc("actions.cancel")}
						error={formError}
						busy={busy}
						onSubmit={(name) => void submitRename(preset.id, name)}
						onCancel={resetInline}
					/>
				) : (
					<div className={styles.presetRow}>
						<button
							type="button"
							role="menuitemradio"
							aria-checked={active}
							className={rowClass(active)}
							onClick={() => void apply(preset.appearance, preset.name)}
						>
							<span className={styles.presetCheck} aria-hidden="true">
								{active ? <Check size={12} /> : null}
							</span>
							<span className={styles.actionMenuMain}>{preset.name}</span>
						</button>
						<button
							type="button"
							className={styles.iconBtn}
							aria-label={ts("stylePresets.moreActions", { name: preset.name })}
							title={ts("stylePresets.moreActions", { name: preset.name })}
							aria-expanded={expanded}
							onClick={() => {
								resetInline();
								setExpandedId(expanded ? null : preset.id);
							}}
						>
							<MoreHorizontal size={14} />
						</button>
					</div>
				)}
				{expanded && !renaming ? (
					<div className={styles.presetActions}>
						{confirmingDelete ? (
							<div className={styles.presetForm}>
								<div className={styles.presetConfirm}>
									{ts("stylePresets.confirmDelete", { name: preset.name })}
								</div>
								<div className={styles.presetFormButtons}>
									<button type="button" className={styles.rowAction} onClick={resetInline}>
										{tc("actions.cancel")}
									</button>
									<button
										type="button"
										className={styles.rowAction}
										disabled={busy}
										onClick={() => void runDelete(preset.id)}
									>
										{ts("stylePresets.delete")}
									</button>
								</div>
							</div>
						) : (
							<>
								{actionRow(ts(revealLabelKey()), () => void runReveal(preset.id))}
								{actionRow(ts("stylePresets.rename"), () => {
									resetInline();
									setMode({ kind: "rename", id: preset.id });
								})}
								{actionRow(ts("stylePresets.update"), () => void runUpdate(preset.id))}
								{actionRow(ts("stylePresets.delete"), () => {
									resetInline();
									setMode({ kind: "confirmDelete", id: preset.id });
								})}
							</>
						)}
						{actionError ? (
							<div className={styles.presetError} role="alert">
								{actionError}
							</div>
						) : null}
					</div>
				) : null}
			</div>
		);
	};

	const factoryActive = sameValue(factory, current);

	return (
		<Popover open={open} onOpenChange={onOpenChange}>
			<PopoverTrigger asChild>
				<button
					type="button"
					className={topbarStyles.ghostBtn}
					aria-expanded={open}
					disabled={!hasDocument}
				>
					<SwatchBook size={15} />
					{ts("stylePresets.button")}
				</button>
			</PopoverTrigger>
			<PopoverContent
				align="end"
				sideOffset={6}
				collisionPadding={12}
				animated={false}
				className="w-auto border-0 bg-transparent p-0 shadow-none"
				onEscapeKeyDown={(event) => {
					// Escape backs out of the inline editor it was pressed in, not out of the menu.
					if (mode.kind !== "idle") {
						event.preventDefault();
						resetInline();
					}
				}}
			>
				<div
					className={styles.actionMenu}
					role="menu"
					aria-label={ts("stylePresets.menuLabel")}
					aria-busy={loading}
				>
					<div className={styles.actionMenuGroup}>{ts("stylePresets.menuLabel")}</div>
					<button
						type="button"
						role="menuitemradio"
						aria-checked={factoryActive}
						key={FACTORY_STYLE_PRESET_ID}
						className={rowClass(factoryActive)}
						onClick={() => void apply(factory, ts("stylePresets.factoryName"))}
					>
						<span className={styles.presetCheck} aria-hidden="true">
							{factoryActive ? <Check size={12} /> : null}
						</span>
						<span className={styles.actionMenuMain}>{ts("stylePresets.factoryName")}</span>
						<span className={styles.actionMenuCount}>{ts("stylePresets.factoryBadge")}</span>
					</button>
					{loading && presets.length === 0 ? (
						<div className={styles.presetStatus}>
							<Loader2 size={12} className="animate-spin" aria-hidden="true" />
						</div>
					) : loadFailed ? (
						<div className={styles.presetStatus} role="alert">
							{ts("stylePresets.loadFailed")}
						</div>
					) : presets.length === 0 ? (
						<div className={styles.presetStatus}>{ts("stylePresets.empty")}</div>
					) : (
						presets.map(renderUserPreset)
					)}
					<div className={styles.presetDivider} />
					{mode.kind === "create" ? (
						<NameForm
							initialName=""
							placeholder={ts("stylePresets.namePlaceholder")}
							saveLabel={ts("stylePresets.save")}
							cancelLabel={tc("actions.cancel")}
							error={formError}
							busy={busy}
							onSubmit={(name) => void submitCreate(name)}
							onCancel={resetInline}
						/>
					) : (
						<button
							type="button"
							role="menuitem"
							className={styles.actionMenuRow}
							onClick={() => {
								resetInline();
								setExpandedId(null);
								setMode({ kind: "create" });
							}}
						>
							<span className={styles.presetActionLabel}>{ts("stylePresets.create")}</span>
						</button>
					)}
				</div>
			</PopoverContent>
		</Popover>
	);
}
