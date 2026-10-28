// Offline visual inspection of actual recorded edits, through the production
// scene builder and locally built native compositor. Never changes model input.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, relative, resolve, sep } from "node:path";
import type { CompositorViewAddon } from "../electron/native/compositor-view/addon";
import { resolveSceneAssetPaths } from "../electron/native-bridge/services/compositorViewService";
import { documentSchema } from "../src/lib/ai-edition/schema";
import { buildNativeClipList, buildSceneDescription } from "../src/native/sceneDescription";
import { readPersistedTurn } from "./lib/persist";
import { captureSourceIdentity } from "./lib/provenance";
import { PUBLIC_DEMO_DIR } from "./lib/public-demo";

async function main() {
	const [runFile, addonFile, outDir] = process.argv.slice(2);
	if (!runFile || !addonFile || !outDir)
		throw new Error("Usage: render-public-demo <rep.json> <local-addon.node> <output-directory>");
	const turn = readPersistedTurn(runFile);
	if (
		!["public-demo-enhance", "public-demo-zooms", "public-demo-grounding"].includes(turn.scenarioId)
	)
		throw new Error("Only registered public-demo turns may be rendered here");
	const document = documentSchema.parse(turn.documents.after);
	const media = resolve(PUBLIC_DEMO_DIR, "demo.webm");
	const hashFile = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
	const inputFiles = ["demo.webm", "demo.webm.cursor.json"].map((name) => ({
		path: `${PUBLIC_DEMO_DIR}/${name}`,
		sha256: hashFile(resolve(PUBLIC_DEMO_DIR, name)),
	}));
	const fixtureFile = resolve(dirname(runFile), "input-fixture.json");
	if (existsSync(fixtureFile)) {
		const expected = JSON.parse(readFileSync(fixtureFile, "utf8")) as {
			files: Array<{ path: string; sha256: string }>;
		};
		if (
			inputFiles.some(
				(file) =>
					!expected.files.some((entry) => entry.path === file.path && entry.sha256 === file.sha256),
			)
		)
			throw new Error("Render media/sidecar bytes differ from recorded fixture descriptor");
	}
	if (document.assets.some((a) => a.originalPath && resolve(a.originalPath) !== media))
		throw new Error("Unexpected media input for the public demo");
	const clips = buildNativeClipList(document).map((c) => ({
		...c,
		screenPath: resolve(c.screenPath),
	}));
	if (clips.some((c) => c.webcamPath)) throw new Error("The public demo has no camera input");
	const scene = buildSceneDescription(document);
	scene.clips = clips;
	process.env.VITE_PUBLIC = resolve("public");
	const sceneJson = resolveSceneAssetPaths(JSON.stringify(scene));
	const resolvedScene = JSON.parse(sceneJson) as typeof scene;
	const publicAssets = new Set<string>();
	const visit = (value: unknown) => {
		if (typeof value === "string" && value.startsWith(`${resolve("public")}${sep}`))
			publicAssets.add(value);
		else if (Array.isArray(value)) value.forEach(visit);
		else if (value && typeof value === "object") Object.values(value).forEach(visit);
	};
	visit(resolvedScene);
	for (const background of [resolvedScene.background, resolvedScene.webcamEffect?.background]) {
		if (
			background?.kind === "image" &&
			!resolve(background.path).startsWith(`${resolve("public")}${sep}`)
		) {
			throw new Error("Public demo render requires a repository-public background image");
		}
	}
	const addon = createRequire(resolve("package.json"))(resolve(addonFile)) as CompositorViewAddon;
	if (!addon.renderFrames) throw new Error("Local native addon has no renderFrames API");
	const fps = 25;
	const frames = [0, 2, 4, 6, 8, 9, 10, 12, 14].map((sec) => sec * fps);
	const rendered = await addon.renderFrames(clips, sceneJson, fps, frames, 800);
	mkdirSync(outDir, { recursive: true });
	const hashes = rendered.map((f) => {
		const name = `frame-${String(f.index).padStart(4, "0")}.jpg`;
		writeFileSync(resolve(outDir, name), f.jpeg);
		return {
			path: name,
			frame: f.index,
			programmeSec: f.index / fps,
			width: f.width,
			height: f.height,
			sha256: createHash("sha256").update(f.jpeg).digest("hex"),
		};
	});
	const nativeSource = createHash("sha256");
	for (const file of execFileSync("git", ["ls-files", "-z", "crates"], { encoding: "utf8" })
		.split("\0")
		.filter(Boolean)
		.sort()) {
		nativeSource
			.update(file)
			.update("\0")
			.update(createHash("sha256").update(readFileSync(file)).digest("hex"))
			.update("\n");
	}
	const source = captureSourceIdentity();
	writeFileSync(
		resolve(outDir, "render.json"),
		JSON.stringify(
			{
				schema: 1,
				scenarioId: turn.scenarioId,
				rep: turn.rep,
				inputRecord: basename(runFile),
				inputSha256: createHash("sha256").update(readFileSync(runFile)).digest("hex"),
				addonSha256: createHash("sha256").update(readFileSync(addonFile)).digest("hex"),
				nativeSourceSha256: nativeSource.digest("hex"),
				platform: process.platform,
				arch: process.arch,
				backend: addon.probeBackend(),
				source: { commit: source.commit, effectiveSha256: source.effectiveSha256 },
				inputFiles,
				publicAssets: [...publicAssets].sort().map((path) => ({
					path: relative(process.cwd(), path).split(sep).join("/"),
					sha256: hashFile(path),
				})),
				fixtureDescriptorSha256: existsSync(fixtureFile) ? hashFile(fixtureFile) : null,
				resolvedSceneSha256: createHash("sha256").update(sceneJson).digest("hex"),
				frames: hashes,
			},
			null,
			"\t",
		) + "\n",
	);
	console.log(
		JSON.stringify({ scenarioId: turn.scenarioId, rep: turn.rep, renderedFrames: hashes.length }),
	);
}
void main().catch((e) => {
	console.error(e instanceof Error ? e.message : "Native rendering failed");
	process.exitCode = 1;
});
