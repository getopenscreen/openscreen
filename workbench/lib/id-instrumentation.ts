import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin as EsbuildPlugin } from "esbuild";
import type { Plugin as VitePlugin } from "vite";

const ID_MODULE = /[\\/]src[\\/]lib[\\/]ai-edition[\\/]document[\\/]ids\.ts$/;
const DECLARATION = "export function createId(prefix: string): string {";

/** Fail closed if the production seam changes. Its body stays untouched. */
export function instrumentDocumentIds(source: string): string {
	if (source.split(DECLARATION).length !== 2) {
		throw new Error("Production createId boundary changed; review Workbench instrumentation");
	}
	return (
		`import { allocateDocumentId } from ${JSON.stringify(resolve("workbench/lib/document-ids.ts"))};\n` +
		source.replace(DECLARATION, "function productionCreateId(prefix: string): string {") +
		"\nexport const workbenchDocumentIds = 1;\nexport function createId(prefix: string): string { return allocateDocumentId(prefix, () => productionCreateId(prefix)); }\n"
	);
}

export function documentIdsEsbuildPlugin(): EsbuildPlugin {
	return {
		name: "workbench-document-ids",
		setup(build) {
			build.onLoad({ filter: ID_MODULE }, ({ path }) => ({
				contents: instrumentDocumentIds(readFileSync(path, "utf8")),
				loader: "ts",
				resolveDir: resolve("src/lib/ai-edition/document"),
			}));
		},
	};
}

export function documentIdsVitePlugin(): VitePlugin {
	return {
		name: "workbench-document-ids",
		enforce: "pre",
		transform(source, id) {
			if (ID_MODULE.test(id.replace(/\\/g, "/"))) return instrumentDocumentIds(source);
		},
	};
}
