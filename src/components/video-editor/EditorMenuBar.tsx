import { Fragment } from "react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface EditorMenuBarProps {
	/** Whether the app is running on macOS. Drives shortcut-hint formatting. */
	isMac: boolean;
	/** Qualified-key translator (e.g. the `rawT` from `useI18n`). */
	t: (qualifiedKey: string) => string;
	onNewProject: () => void;
	onLoadProject: () => void;
	onSaveProject: () => void;
	onSaveProjectAs: () => void;
	onQuit: () => void;
	onUndo: () => void;
	onRedo: () => void;
	onReload: () => void;
	canUndo: boolean;
	canRedo: boolean;
}

export interface EditorMenuItem {
	id: string;
	label: string;
	/** Human-readable, platform-aware shortcut hint (e.g. "Ctrl+N" / "⌘N"). */
	shortcut?: string;
	onSelect: () => void;
	disabled?: boolean;
	/** Renders the item in a destructive (red) style, e.g. Quit. */
	danger?: boolean;
	/** Draws a separator immediately before this item. */
	separatorBefore?: boolean;
}

export interface EditorMenu {
	id: string;
	label: string;
	minWidthClass: string;
	items: EditorMenuItem[];
}

/**
 * Formats a menu shortcut hint for the current platform. macOS uses the symbol
 * modifier with no separator ("⌘N"); everywhere else uses "Ctrl+N". These mirror
 * the accelerators wired in the native menu (electron/main.ts) and the editor
 * keydown handler, so the hints stay truthful.
 */
export function formatShortcut(isMac: boolean, key: string): string {
	return isMac ? `⌘${key}` : `Ctrl+${key}`;
}

export function formatShiftShortcut(isMac: boolean, key: string): string {
	return isMac ? `⌘⇧${key}` : `Ctrl+Shift+${key}`;
}

/**
 * Pure description of the editor's File / Edit / View menus. Kept separate from
 * the rendering so the labels, shortcut hints, disabled states, and handler
 * wiring can be unit-tested without mounting Radix/jsdom.
 */
export function buildEditorMenuModel(props: EditorMenuBarProps): EditorMenu[] {
	const { isMac, t } = props;

	return [
		{
			id: "file",
			label: t("common.actions.file"),
			minWidthClass: "min-w-[170px]",
			items: [
				{
					id: "new-project",
					label: t("dialogs.unsavedChanges.newProject"),
					shortcut: formatShortcut(isMac, "N"),
					onSelect: props.onNewProject,
				},
				{
					id: "load-project",
					label: t("dialogs.unsavedChanges.loadProject"),
					shortcut: formatShortcut(isMac, "O"),
					onSelect: props.onLoadProject,
					separatorBefore: true,
				},
				{
					id: "save-project",
					label: t("dialogs.unsavedChanges.saveProject"),
					shortcut: formatShortcut(isMac, "S"),
					onSelect: props.onSaveProject,
				},
				{
					id: "save-project-as",
					label: t("dialogs.unsavedChanges.saveProjectAs"),
					shortcut: formatShiftShortcut(isMac, "S"),
					onSelect: props.onSaveProjectAs,
				},
				{
					id: "quit",
					label: t("common.actions.quit"),
					shortcut: formatShortcut(isMac, "Q"),
					onSelect: props.onQuit,
					danger: true,
					separatorBefore: true,
				},
			],
		},
		{
			id: "edit",
			label: t("common.actions.edit"),
			minWidthClass: "min-w-[130px]",
			items: [
				{
					id: "undo",
					label: t("common.actions.undo"),
					shortcut: formatShortcut(isMac, "Z"),
					onSelect: props.onUndo,
					disabled: !props.canUndo,
				},
				{
					id: "redo",
					label: t("common.actions.redo"),
					// Redo is bound to both Ctrl+Y and Ctrl+Shift+Z; show the
					// idiomatic hint per platform (⌘⇧Z on macOS, Ctrl+Y elsewhere).
					shortcut: isMac ? formatShiftShortcut(isMac, "Z") : formatShortcut(isMac, "Y"),
					onSelect: props.onRedo,
					disabled: !props.canRedo,
				},
			],
		},
		{
			id: "view",
			label: t("common.actions.view"),
			minWidthClass: "min-w-[130px]",
			items: [
				{
					id: "reload",
					label: t("common.actions.reload"),
					shortcut: formatShortcut(isMac, "R"),
					onSelect: props.onReload,
				},
			],
		},
	];
}

/**
 * Custom in-app menu bar (File / Edit / View) shown in the editor's titlebar.
 * Replaces the native OS menu bar that is auto-hidden on Windows/Linux
 * (see electron/windows.ts).
 */
export function EditorMenuBar(props: EditorMenuBarProps) {
	const menus = buildEditorMenuModel(props);

	return (
		<div className={`flex items-center gap-0.5 ${props.isMac ? "ml-14" : "ml-2"}`}>
			{menus.map((menu) => (
				<DropdownMenu key={menu.id}>
					<DropdownMenuTrigger asChild>
						<button
							type="button"
							className="px-2.5 py-1.5 rounded-lg text-[13px] font-semibold text-slate-300 hover:text-white hover:bg-white/[0.08] transition-all duration-150 outline-none focus-visible:ring-1 focus-visible:ring-white/20 focus-visible:bg-white/[0.08]"
						>
							{menu.label}
						</button>
					</DropdownMenuTrigger>
					<DropdownMenuContent
						align="start"
						className={`bg-[#09090b]/95 backdrop-blur-md border border-white/[0.08] text-slate-200 ${menu.minWidthClass}`}
					>
						{menu.items.map((item) => (
							<Fragment key={item.id}>
								{item.separatorBefore && <DropdownMenuSeparator className="bg-white/[0.08]" />}
								<DropdownMenuItem
									onClick={item.onSelect}
									disabled={item.disabled}
									className={
										item.danger
											? "hover:bg-red-500/20 focus:bg-red-500/20 focus:text-red-400 text-red-400 cursor-pointer justify-between"
											: "hover:bg-white/[0.08] focus:bg-white/[0.08] focus:text-white cursor-pointer justify-between disabled:opacity-40 disabled:pointer-events-none"
									}
								>
									<span>{item.label}</span>
									{item.shortcut && (
										<DropdownMenuShortcut className="ml-2">{item.shortcut}</DropdownMenuShortcut>
									)}
								</DropdownMenuItem>
							</Fragment>
						))}
					</DropdownMenuContent>
				</DropdownMenu>
			))}
		</div>
	);
}
