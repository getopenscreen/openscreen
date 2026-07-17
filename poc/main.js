// POC: two videos, one layout, three effects, full shader. Standalone.
//
// No Electron, no app code, no old paradigm: decode (mediabunny) → WebGPU →
// encode (mediabunny) → an mp4 you can watch, and one number: fps.
//
// The layout is 40 lines of arithmetic written here, not imported: the point is
// to prove the paradigm reconstructs the product, not to reuse what exists.

import {
	ALL_FORMATS,
	BufferTarget,
	Input,
	Mp4OutputFormat,
	Output,
	UrlSource,
	VideoSampleSink,
} from "mediabunny";

const OUT = { width: 1920, height: 1080, fps: 30 };
const log = (msg) => {
	document.querySelector("#log").textContent += `${msg}\n`;
};
const setStat = (id, value) => {
	document.querySelector(`#${id}`).textContent = value;
};

// ---- evaluate: (scene, t) → the frame's geometry. Written from zero. --------
//
// Pure arithmetic, no GPU, no canvas. Everything the shader needs is decided
// here, so the same function can drive a preview later without a second
// implementation to keep in sync.

const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);

/** Ramp 0→1→0 across a region, eased in and out over `ramp` seconds. */
function regionStrength(t, start, end, ramp) {
	if (t <= start || t >= end) return 0;
	const inRamp = Math.min(1, (t - start) / ramp);
	const outRamp = Math.min(1, (end - t) / ramp);
	return easeInOut(Math.min(inRamp, outRamp));
}

const lerp = (a, b, t) => a + (b - a) * t;
const lerpRect = (a, b, t) => ({
	x: lerp(a.x, b.x, t),
	y: lerp(a.y, b.y, t),
	w: lerp(a.w, b.w, t),
	h: lerp(a.h, b.h, t),
});

/** The base layout: recording centred with padding, webcam docked bottom-right. */
function baseLayout(stage, padding) {
	const s = 1 - (padding / 100) * 0.4;
	const w = stage.width * s;
	const h = stage.height * s;
	const screen = { x: (stage.width - w) / 2, y: (stage.height - h) / 2, w, h };
	const size = Math.round(stage.height * 0.22);
	const margin = Math.round(stage.height * 0.04);
	const webcam = {
		x: stage.width - size - margin,
		y: stage.height - size - margin,
		w: size,
		h: size,
	};
	return { screen, webcam };
}

/**
 * The whole timeline of this POC, as data.
 *
 * Two things move, and they are the two the product actually has:
 *  - a ZOOM on the recording: scale + focus point, eased in and out;
 *  - a LAYOUT ANIMATION on the webcam: it grows from the docked bubble to a
 *    large panel and its shape morphs from circle to rounded rect on the way.
 */
function scene(stage, padding) {
	return {
		stage,
		padding,
		zooms: [
			{ start: 1.0, end: 3.2, scale: 1.7, focus: { x: 0.62, y: 0.42 }, ramp: 0.55 },
			{ start: 4.4, end: 6.5, scale: 2.3, focus: { x: 0.3, y: 0.7 }, ramp: 0.5 },
		],
		layoutMoves: [{ start: 2.4, end: 5.0, ramp: 0.6 }],
	};
}

function evaluate(sc, t, prev) {
	const base = baseLayout(sc.stage, sc.padding);

	// --- zoom: strongest region wins, eased ---
	let zoomScale = 1;
	let focus = { x: 0.5, y: 0.5 };
	let strength = 0;
	for (const z of sc.zooms) {
		const s = regionStrength(t, z.start, z.end, z.ramp);
		if (s > strength) {
			strength = s;
			zoomScale = lerp(1, z.scale, s);
			focus = z.focus;
		}
	}
	// Scale about the focus point, then keep the recording covering the stage:
	// a zoom that reveals the background behind the video is a bug, not a look.
	const fx = base.screen.x + base.screen.w * focus.x;
	const fy = base.screen.y + base.screen.h * focus.y;
	const screen = {
		x: fx - (fx - base.screen.x) * zoomScale,
		y: fy - (fy - base.screen.y) * zoomScale,
		w: base.screen.w * zoomScale,
		h: base.screen.h * zoomScale,
	};

	// --- layout animation: the webcam grows into a panel and un-rounds ---
	let move = 0;
	for (const m of sc.layoutMoves) {
		move = Math.max(move, regionStrength(t, m.start, m.end, m.ramp));
	}
	const panelW = Math.round(sc.stage.width * 0.34);
	const panelH = Math.round(panelW * 0.75);
	const margin = Math.round(sc.stage.height * 0.04);
	const panel = {
		x: sc.stage.width - panelW - margin,
		y: sc.stage.height - panelH - margin,
		w: panelW,
		h: panelH,
	};
	const webcam = lerpRect(base.webcam, panel, move);
	// Circle when docked (radius = half the bubble), rounded rect when grown.
	const webcamRadius = lerp(Math.min(base.webcam.w, base.webcam.h) / 2, 26, move);

	// --- velocity: what the motion blur is for ---
	const cx = screen.x + screen.w / 2;
	const cy = screen.y + screen.h / 2;
	let velocity = 0;
	if (prev) {
		velocity = Math.hypot(cx - prev.cx, cy - prev.cy) + Math.abs(screen.w - prev.w) * 0.5;
	}

	return {
		screen,
		webcam,
		webcamRadius,
		zoomScale,
		motionBlurPx: Math.min(velocity * 0.35, 24),
		memo: { cx, cy, w: screen.w },
	};
}

// ---- decode ----------------------------------------------------------------

async function openVideo(url) {
	const input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS });
	const track = await input.getPrimaryVideoTrack();
	if (!track) throw new Error(`no video track in ${url}`);
	const sink = new VideoSampleSink(track);
	return { input, track, sink };
}

// ---- run -------------------------------------------------------------------

async function run() {
	const started = performance.now();
	document.querySelector("#run").disabled = true;
	log("opening sources…");

	const [screen, webcam] = await Promise.all([
		openVideo("media/screen.mp4"),
		openVideo("media/webcam.mp4"),
	]);
	const seconds = Number(document.querySelector("#seconds").value);
	const screenDuration = await screen.track.computeDuration();
	const duration = Math.min(seconds, screenDuration);
	const totalFrames = Math.floor(duration * OUT.fps);
	log(
		`screen ${screen.track.displayWidth}x${screen.track.displayHeight} · ${screenDuration.toFixed(1)}s`,
	);
	log(`webcam ${webcam.track.displayWidth}x${webcam.track.displayHeight}`);
	log(`rendering ${totalFrames} frames @ ${OUT.fps}fps (${duration.toFixed(1)}s)`);

	// ---- GPU ----
	if (!navigator.gpu) throw new Error("WebGPU unavailable");
	const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
	const device = await adapter.requestDevice();
	const info = adapter.info ?? {};
	log(`gpu: ${info.vendor ?? "?"} ${info.architecture ?? ""}`);

	// OffscreenCanvas: no document, no presentation, no compositor.
	//
	// This is a measurement decision, not a detail. A canvas in the page is
	// PRESENTED every frame — the browser composites 2 Mpx into the layout and the
	// swapchain waits on the display's refresh. Measured here: 34.9 ms/frame of
	// fixed cost with every effect switched OFF, eight times the effects
	// themselves. An export presents nothing to anyone, so a measurement that pays
	// for presentation is measuring a different program.
	const canvas = new OffscreenCanvas(OUT.width, OUT.height);
	const ctx = canvas.getContext("webgpu");
	const format = navigator.gpu.getPreferredCanvasFormat();
	ctx.configure({ device, format, alphaMode: "opaque" });

	const previewCanvas = document.querySelector("#stage");
	previewCanvas.width = 640;
	previewCanvas.height = 360;
	const preview = previewCanvas.getContext("2d");

	const code = await (await fetch("composite.wgsl")).text();
	const module = device.createShaderModule({ code });
	device.pushErrorScope("validation");
	const pipeline = device.createRenderPipeline({
		layout: "auto",
		vertex: { module, entryPoint: "vs" },
		fragment: { module, entryPoint: "fs", targets: [{ format }] },
		primitive: { topology: "triangle-list" },
	});
	const shaderError = await device.popErrorScope();
	if (shaderError) throw new Error(`shader: ${shaderError.message}`);

	const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
	// 5 vec4 = 80 bytes. All-vec4 on purpose: WGSL pads mixed structs and the CPU
	// packing has to reproduce the holes exactly — get one offset wrong and the
	// shader reads a radius where a rect belongs, draws nothing, and reports no
	// error at all.
	const uniforms = new Float32Array(20);
	const uniformBuffer = device.createBuffer({
		size: uniforms.byteLength,
		usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
	});

	// ---- encode ----
	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const { CanvasSource, QUALITY_HIGH } = await import("mediabunny");
	const source = new CanvasSource(canvas, { codec: "avc", bitrate: QUALITY_HIGH });
	output.addVideoTrack(source, { frameRate: OUT.fps });
	await output.start();

	const sc = scene(OUT, Number(document.querySelector("#padding").value));
	const shadowIntensity = Number(document.querySelector("#shadow").value);
	const bgBlur = Number(document.querySelector("#blur").value);
	const camAspect = webcam.track.displayWidth / webcam.track.displayHeight;
	let memo = null;

	// ---- decode: forward streams, not seeks ----
	// getSample(t) per frame is a random-access SEEK per frame: on a long-GOP
	// screen recording that means re-decoding from the last keyframe, every time.
	// Measured at 122 ms/frame — 3x the cost of everything else combined. These
	// videos are read start to end, so read them start to end: two generators,
	// each advanced to the frame the output clock is asking for.
	const screenStream = screen.sink.samples(0, duration);
	const webcamStream = webcam.sink.samples(0, duration);
	const nextFrom = async (stream, holder, t) => {
		// Advance while the NEXT sample still starts at or before t.
		while (
			!holder.done &&
			(!holder.current || holder.current.timestamp + holder.current.duration <= t)
		) {
			const { value, done } = await stream.next();
			if (done) {
				holder.done = true;
				break;
			}
			holder.current?.close();
			holder.current = value;
		}
		return holder.current ?? null;
	};
	const screenHolder = { current: null, done: false };
	const webcamHolder = { current: null, done: false };

	// ---- the loop ----
	const t0 = performance.now();
	let decodeMs = 0;
	let renderMs = 0;
	let encodeMs = 0;
	let rendered = 0;

	for (let i = 0; i < totalFrames; i++) {
		const t = i / OUT.fps;

		const d0 = performance.now();
		const screenSample = await nextFrom(screenStream, screenHolder, t);
		const webcamSample = await nextFrom(webcamStream, webcamHolder, t);
		decodeMs += performance.now() - d0;
		if (!screenSample) break;

		const r0 = performance.now();
		const screenFrame = screenSample.toVideoFrame();
		const webcamFrame = webcamSample ? webcamSample.toVideoFrame() : null;

		const f = evaluate(sc, t, memo);
		memo = f.memo;
		// Field n at float 4n — the struct is all-vec4 so this stays true.
		uniforms.set([OUT.width, OUT.height, t, 28], 0); // stage | time | radius
		uniforms.set([f.screen.x, f.screen.y, f.screen.w, f.screen.h], 4);
		uniforms.set([f.webcam.x, f.webcam.y, f.webcam.w, f.webcam.h], 8);
		uniforms.set([shadowIntensity, bgBlur, 18, 42], 12); // intensity | bgBlur | offsetY | spread
		uniforms.set([f.webcamRadius, f.motionBlurPx, camAspect, 0], 16);
		device.queue.writeBuffer(uniformBuffer, 0, uniforms);

		const bind = device.createBindGroup({
			layout: pipeline.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: { buffer: uniformBuffer } },
				{ binding: 1, resource: sampler },
				{ binding: 2, resource: device.importExternalTexture({ source: screenFrame }) },
				{
					binding: 3,
					resource: device.importExternalTexture({ source: webcamFrame ?? screenFrame }),
				},
			],
		});

		const encoder = device.createCommandEncoder();
		const pass = encoder.beginRenderPass({
			colorAttachments: [
				{
					view: ctx.getCurrentTexture().createView(),
					clearValue: { r: 0, g: 0, b: 0, a: 1 },
					loadOp: "clear",
					storeOp: "store",
				},
			],
		});
		pass.setPipeline(pipeline);
		pass.setBindGroup(0, bind);
		pass.draw(3);
		pass.end();
		device.queue.submit([encoder.finish()]);
		// Force the GPU to FINISH before the timer stops. Without it this measures
		// submission, and the cost lands on whoever syncs next — the encoder.
		await device.queue.onSubmittedWorkDone();
		renderMs += performance.now() - r0;

		const e0 = performance.now();
		await source.add(t, 1 / OUT.fps);
		encodeMs += performance.now() - e0;

		// The VideoFrames are ours; the samples belong to the streams, which close
		// them when they advance.
		screenFrame.close();
		webcamFrame?.close();

		rendered++;
		if (i % 15 === 0) {
			setStat("progress", `${i}/${totalFrames}`);
			// A 640px preview every 15 frames. It is OFF the clock — the timers above
			// have already stopped — and it never touches the render path.
			preview.drawImage(canvas, 0, 0, previewCanvas.width, previewCanvas.height);
			await new Promise((r) => setTimeout(r, 0));
		}
	}

	const wallMs = performance.now() - t0;
	await output.finalize();

	// ---- report: one number that compares ----
	const fps = rendered / (wallMs / 1000);
	setStat("fps", fps.toFixed(1));
	setStat("progress", `${rendered}/${totalFrames}`);
	setStat("render", `${(renderMs / rendered).toFixed(1)} ms`);
	setStat("decode", `${(decodeMs / rendered).toFixed(1)} ms`);
	setStat("encode", `${(encodeMs / rendered).toFixed(1)} ms`);
	setStat("perframe", `${(wallMs / rendered).toFixed(1)} ms`);
	log(`\n=== ${rendered} frames in ${(wallMs / 1000).toFixed(2)}s → ${fps.toFixed(1)} fps ===`);
	log(
		`composite ${(renderMs / rendered).toFixed(1)} ms · decode ${(decodeMs / rendered).toFixed(1)} ms · encode ${(encodeMs / rendered).toFixed(1)} ms  (per frame)`,
	);
	log(`setup ${((t0 - started) / 1000).toFixed(1)}s`);

	const blob = new Blob([output.target.buffer], { type: "video/mp4" });
	const url = URL.createObjectURL(blob);
	const player = document.querySelector("#result");
	player.src = url;
	player.hidden = false;
	const dl = document.querySelector("#download");
	dl.href = url;
	dl.download = "poc.mp4";
	dl.hidden = false;

	// On disk too: a blob URL dies with the tab, and the output has to be
	// watchable outside this page.
	const written = await fetch("/save?name=poc.mp4", { method: "POST", body: blob }).then((r) =>
		r.text(),
	);
	log(`output: ${(blob.size / 1e6).toFixed(1)} MB → ${written}`);

	document.querySelector("#run").disabled = false;
}

document.querySelector("#run").addEventListener("click", () => {
	document.querySelector("#log").textContent = "";
	run().catch((error) => {
		log(`\nFAILED: ${error.message}`);
		console.error(error);
		document.querySelector("#run").disabled = false;
	});
});
