import type { Span } from "dnd-timeline";
import { useItem } from "dnd-timeline";
import {
	Gauge,
	Maximize,
	MessageSquare,
	MousePointer2,
	Scissors,
	Spline,
	ZoomIn,
} from "lucide-react";
import { useMemo } from "react";
import { useScopedT } from "@/contexts/I18nContext";
import { cn } from "@/lib/utils";
import glassStyles from "./ItemGlass.module.css";

interface ItemProps {
	id: string;
	span: Span;
	rowId: string;
	children: React.ReactNode;
	isSelected?: boolean;
	onSelect?: () => void;
	zoomDepth?: number;
	zoomCustomScale?: number;
	speedValue?: number;
	isAutoFocus?: boolean;
	disabled?: boolean;
	variant?:
		| "zoom"
		| "camera-fullscreen"
		| "trim"
		| "annotation"
		| "speed"
		| "blur"
		| "cursor-motion";
}

// Map zoom depth to multiplier labels
const ZOOM_LABELS: Record<number, string> = {
	1: "1.25×",
	2: "1.5×",
	3: "1.8×",
	4: "2.2×",
	5: "3.5×",
	6: "5×",
};

function formatMs(ms: number): string {
	const totalSeconds = ms / 1000;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes > 0) {
		return `${minutes}:${seconds.toFixed(1).padStart(4, "0")}`;
	}
	return `${seconds.toFixed(1)}s`;
}

export default function Item({
	id,
	span,
	rowId,
	isSelected = false,
	onSelect,
	zoomDepth = 1,
	zoomCustomScale,
	speedValue,
	isAutoFocus = false,
	disabled = false,
	variant = "zoom",
	children,
}: ItemProps) {
	const t = useScopedT("timeline");
	const { setNodeRef, attributes, listeners, itemStyle, itemContentStyle } = useItem({
		id,
		span,
		disabled,
		data: { rowId },
	});

	const isZoom = variant === "zoom";
	const isCameraFullscreen = variant === "camera-fullscreen";
	const isTrim = variant === "trim";
	const isSpeed = variant === "speed";
	const isCursorMotion = variant === "cursor-motion";

	const glassClass = isZoom
		? glassStyles.glassGreen
		: isCameraFullscreen
			? glassStyles.glassBlue
			: isTrim
				? glassStyles.glassRed
				: isSpeed
					? glassStyles.glassAmber
					: isCursorMotion
						? glassStyles.glassPurple
						: glassStyles.glassYellow;

	const endCapColor = isZoom
		? "#21916A"
		: isCameraFullscreen
			? "#0ea5e9"
			: isTrim
				? "#ef4444"
				: isSpeed
					? "#d97706"
					: isCursorMotion
						? "#8b5cf6"
						: "#B4A046";

	const timeLabel = useMemo(
		() => `${formatMs(span.start)} – ${formatMs(span.end)}`,
		[span.start, span.end],
	);

	// Minimum clickable width on the outer wrapper. Kept small so items keep their real
	// positions; zoom in to interact with sub-second items precisely.
	const MIN_ITEM_PX = 6;
	const safeItemStyle = { ...itemStyle, minWidth: MIN_ITEM_PX };

	return (
		<div
			ref={setNodeRef}
			style={safeItemStyle}
			{...listeners}
			{...attributes}
			onPointerDownCapture={() => onSelect?.()}
			className="group"
		>
			<div style={{ ...itemContentStyle, minWidth: 24 }}>
				<div
					className={cn(
						glassClass,
						"w-full h-full overflow-hidden flex items-center justify-center gap-1.5 relative",
						disabled ? "cursor-pointer" : "cursor-grab active:cursor-grabbing",
						isSelected && glassStyles.selected,
					)}
					style={{ height: 30, color: "#fff", minWidth: 24 }}
					onClick={(event) => {
						event.stopPropagation();
						onSelect?.();
					}}
				>
					{!disabled && (
						<>
							<div
								className={cn(glassStyles.zoomEndCap, glassStyles.left)}
								style={{
									cursor: "col-resize",
									pointerEvents: "auto",
									width: 8,
									opacity: 0.9,
									background: endCapColor,
								}}
								title="Resize left"
							/>
							<div
								className={cn(glassStyles.zoomEndCap, glassStyles.right)}
								style={{
									cursor: "col-resize",
									pointerEvents: "auto",
									width: 8,
									opacity: 0.9,
									background: endCapColor,
								}}
								title="Resize right"
							/>
						</>
					)}
					{/* Content */}
					<div className="relative z-10 flex min-w-0 flex-col items-center justify-center text-white/90 opacity-85 group-hover:opacity-100 transition-opacity select-none overflow-hidden px-3">
						<div className="flex items-center gap-1.5">
							{isZoom ? (
								<>
									<ZoomIn className="w-3.5 h-3.5 shrink-0" />
									<span className="text-[11px] font-semibold whitespace-nowrap">
										{zoomCustomScale != null
											? `${zoomCustomScale.toFixed(2)}×`
											: ZOOM_LABELS[zoomDepth] || `${zoomDepth}×`}
									</span>
									{isAutoFocus && (
										<MousePointer2
											className="w-3 h-3 shrink-0 opacity-90"
											aria-label="Cursor-follow"
										/>
									)}
								</>
							) : isCameraFullscreen ? (
								<>
									<Maximize className="w-3.5 h-3.5 shrink-0" />
									<span className="text-[11px] font-semibold whitespace-nowrap">
										{t("labels.cameraFullscreen")}
									</span>
								</>
							) : isTrim ? (
								<>
									<Scissors className="w-3.5 h-3.5 shrink-0" />
									<span className="text-[11px] font-semibold whitespace-nowrap">
										{t("labels.trim")}
									</span>
								</>
							) : isSpeed ? (
								<>
									<Gauge className="w-3.5 h-3.5 shrink-0" />
									<span className="text-[11px] font-semibold whitespace-nowrap">
										{speedValue !== undefined ? `${speedValue}×` : t("labels.speed")}
									</span>
								</>
							) : isCursorMotion ? (
								<>
									<Spline className="w-3.5 h-3.5 shrink-0" />
									<span className="text-[11px] font-semibold truncate whitespace-nowrap">
										{children}
									</span>
								</>
							) : (
								<>
									<MessageSquare className="w-3.5 h-3.5 shrink-0" />
									<span className="text-[11px] font-semibold truncate whitespace-nowrap">
										{children}
									</span>
								</>
							)}
						</div>
						<span
							className={`text-[9px] tabular-nums tracking-tight whitespace-nowrap transition-opacity ${
								isSelected ? "opacity-60" : "opacity-0 group-hover:opacity-40"
							}`}
						>
							{timeLabel}
						</span>
					</div>
				</div>
			</div>
		</div>
	);
}
