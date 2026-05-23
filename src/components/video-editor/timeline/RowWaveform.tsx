import { useTimelineContext } from "dnd-timeline";
import { useEffect, useRef, useState } from "react";

export interface RowWaveformProps {
	/** Pre-computed peaks array: pairs of [min, max] per block (length = 2 * N). */
	peaks: Float32Array | null;
	videoDurationMs: number;
}

/**
 * Renders a faint audio waveform on a `<canvas>` element that fills its
 * containing row. Designed to be passed as the `background` prop of `<Row>`.
 *
 * - Accepts pre-computed `peaks` from the caller (see `useAudioPeaks`).
 * - Redraws whenever the timeline zoom/pan range changes.
 * - `pointer-events: none` throughout — never blocks drag-to-create interactions.
 */
export default function RowWaveform({ peaks, videoDurationMs }: RowWaveformProps) {
	const { range } = useTimelineContext();
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const wrapperRef = useRef<HTMLDivElement>(null);
	const [canvasSize, setCanvasSize] = useState({ w: 0, h: 0 });

	// Track container dimensions via ResizeObserver.
	useEffect(() => {
		const el = wrapperRef.current;
		if (!el) return;
		const ro = new ResizeObserver((entries) => {
			const { width, height } = entries[0].contentRect;
			setCanvasSize({ w: width, h: height });
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	// Redraw whenever peaks, range, or container size changes.
	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas || !peaks || canvasSize.w <= 0 || canvasSize.h <= 0) return;

		const dpr = window.devicePixelRatio || 1;
		canvas.width = Math.round(canvasSize.w * dpr);
		canvas.height = Math.round(canvasSize.h * dpr);

		const ctx = canvas.getContext("2d");
		if (!ctx) return;

		ctx.scale(dpr, dpr);
		ctx.clearRect(0, 0, canvasSize.w, canvasSize.h);

		const W = canvasSize.w;
		const H = canvasSize.h;
		const mid = H / 2;
		const amp = mid * 0.9;
		const rangeMs = range.end - range.start;
		if (rangeMs <= 0 || videoDurationMs <= 0) return;

		const N = peaks.length / 2;

		ctx.beginPath();
		ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
		ctx.lineWidth = 1;

		for (let x = 0; x < W; x++) {
			const startMs = range.start + (x / W) * rangeMs;
			const endMs = range.start + ((x + 1) / W) * rangeMs;
			const lo = Math.max(0, Math.floor((startMs / videoDurationMs) * N));
			const hi = Math.min(N - 1, Math.ceil((endMs / videoDurationMs) * N));

			let minVal = 0;
			let maxVal = 0;
			for (let i = lo; i <= hi; i++) {
				const mn = peaks[i * 2];
				const mx = peaks[i * 2 + 1];
				if (mn < minVal) minVal = mn;
				if (mx > maxVal) maxVal = mx;
			}

			ctx.moveTo(x + 0.5, mid - maxVal * amp);
			ctx.lineTo(x + 0.5, mid - minVal * amp);
		}

		ctx.stroke();
	}, [peaks, range, canvasSize, videoDurationMs]);

	return (
		<div ref={wrapperRef} className="absolute inset-0 pointer-events-none overflow-hidden">
			<canvas
				ref={canvasRef}
				style={{ width: canvasSize.w, height: canvasSize.h, display: "block" }}
			/>
		</div>
	);
}
