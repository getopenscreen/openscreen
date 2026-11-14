import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { documentIdsEsbuildPlugin } from "./lib/id-instrumentation";

void build({
	entryPoints: {
		cli: "workbench/cli-entry.ts",
		"measurement-cli": "workbench/measurement-entry.ts",
		"render-public-demo": "workbench/render-public-demo.ts",
	},
	outdir: "workbench/.build",
	outExtension: { ".js": ".cjs" },
	bundle: true,
	platform: "node",
	format: "cjs",
	packages: "external",
	plugins: [documentIdsEsbuildPlugin()],
	define: {
		"import.meta.url": JSON.stringify(
			pathToFileURL(resolve("workbench/.build/render-public-demo.cjs")).href,
		),
	},
}).catch(() => {
	process.exitCode = 1;
});
