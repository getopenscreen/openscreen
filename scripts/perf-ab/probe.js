// Injected into the editor renderer. Same code for both versions: rAF timestamps, every paint of
// the preview canvas (the one `useNativeCompositorView` marks `data-painted`), long tasks.
(() => {
	if (window.__bench) return true;
	const B = { raf: [], draw: [], shared: 0, readback: 0, lt: [], on: false };
	window.__bench = B;
	const loop = (t) => {
		if (!B.on) return;
		B.raf.push(Math.round(t * 1000) / 1000);
		requestAnimationFrame(loop);
	};
	B.start = () => {
		B.raf = [];
		B.draw = [];
		B.lt = [];
		B.shared = 0;
		B.readback = 0;
		B.t0 = performance.now();
		B.on = true;
		requestAnimationFrame(loop);
	};
	B.stop = () => {
		B.on = false;
		return {
			t0: B.t0,
			t1: performance.now(),
			raf: B.raf,
			draw: B.draw,
			shared: B.shared,
			readback: B.readback,
			lt: B.lt,
		};
	};
	const drawImage = CanvasRenderingContext2D.prototype.drawImage;
	CanvasRenderingContext2D.prototype.drawImage = function (src, ...rest) {
		const c = this.canvas;
		if (B.on && c && c.dataset && "painted" in c.dataset) {
			B.draw.push(Math.round(performance.now() * 1000) / 1000);
			if (typeof VideoFrame !== "undefined" && src instanceof VideoFrame) B.shared++;
			else B.readback++;
		}
		return drawImage.call(this, src, ...rest);
	};
	try {
		new PerformanceObserver((list) => {
			if (B.on)
				for (const e of list.getEntries())
					B.lt.push([Math.round(e.startTime), Math.round(e.duration)]);
		}).observe({ entryTypes: ["longtask"] });
	} catch {
		// no longtask entries in this Chromium: the rAF and paint timings still stand
	}
	return true;
})();
