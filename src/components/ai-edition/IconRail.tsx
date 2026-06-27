import { useState } from "react";
// ponytail: vertical icon rail. The right rail has 7 tabs (Transcript +
// Background / Video effects / Camera / Cursor / Crop / Export from the
// original OpenScreen settings panel). The left rail has 2 tabs (Project +
// Chat). Uses OpenScreen's dark surface + green active accent.

export type LeftTab = "project" | "chat";
export type RightTab =
	| "transcript"
	| "background"
	| "effects"
	| "camera"
	| "cursor"
	| "crop"
	| "export";

interface IconRailProps {
	side: "left" | "right";
	tabs: Array<{ id: string; label: string; icon: React.ElementType }>;
	active: string;
	onChange: (id: string) => void;
	collapsed: boolean;
	onToggleCollapse: () => void;
}

export function IconRail({
	side,
	tabs,
	active,
	onChange,
	collapsed,
	// ponytail: collapse lives in the top header now. Kept for API compat.
	onToggleCollapse: _onToggleCollapse,
}: IconRailProps) {
	return (
		<div
			className={`shrink-0 h-full flex flex-col items-center bg-[#0a0b0e] border-white/[0.07] ${
				side === "left" ? "border-r" : "border-l"
			}`}
			style={{ width: 44 }}
		>
			<div className="flex-1 flex flex-col items-center gap-0.5 py-2 overflow-y-auto w-full">
				{tabs.map((tab) => {
					const isActive = tab.id === active && !collapsed;
					const Icon = tab.icon;
					return (
						<button
							type="button"
							key={tab.id}
							className={`group relative flex items-center justify-center w-9 h-9 rounded-md transition-colors mx-auto ${
								isActive
									? "bg-[#34B27B]/15 text-[#34B27B]"
									: "text-white/40 hover:text-white/85 hover:bg-white/[0.06]"
							}`}
							onClick={() => onChange(tab.id)}
							title={tab.label}
							aria-label={tab.label}
							aria-pressed={isActive}
						>
							<Icon size={16} />
							<span
								className={`pointer-events-none absolute ${
									side === "left" ? "left-full ml-2" : "right-full mr-2"
								} px-2 py-1 rounded-md bg-[#1a1c20] text-white/85 text-[11px] whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity z-50`}
							>
								{tab.label}
							</span>
						</button>
					);
				})}
			</div>
		</div>
	);
}

export function usePanelTabs() {
	const [leftTab, setLeftTab] = useState<LeftTab>("project");
	const [rightTab, setRightTab] = useState<RightTab>("background");
	const [leftCollapsed, setLeftCollapsed] = useState(false);
	const [rightCollapsed, setRightCollapsed] = useState(true);

	return {
		leftTab,
		setLeftTab,
		rightTab,
		setRightTab,
		leftCollapsed,
		setLeftCollapsed,
		rightCollapsed,
		setRightCollapsed,
	};
}
