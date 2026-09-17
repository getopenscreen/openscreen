// Where the renderer's static assets live: `public/` in an unpackaged run, `resources/`
// in a packaged one (electron-builder's `extraResources` copies `public/wallpapers`,
// `public/cursors` and `public/music` there).
//
// Its own module, with NO electron import, because the music catalogue resolves paths
// through it and has to stay loadable in a plain node test. `electron/windows.ts` reads
// electron at module scope, so importing it just for this constant dragged the whole
// window layer — and `process.getSystemVersion` — into every test that touched the
// relinker.
//
// A function rather than a constant for the same reason: nothing is computed until
// somebody asks.

import path from "node:path";
import { fileURLToPath } from "node:url";

// The main bundle is ESM (`"type": "module"`), so there is no ambient `__dirname` —
// `electron/windows.ts` derives its own the same way. Getting this wrong does not fail
// the build, the typecheck or the test suite: it throws at app load.
const here = path.dirname(fileURLToPath(import.meta.url));

export function assetBaseDir(): string {
	return process.defaultApp ? path.join(here, "..", "public") : process.resourcesPath;
}
