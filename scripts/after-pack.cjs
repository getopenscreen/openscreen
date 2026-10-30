// electron-builder afterPack hook: give the macOS bundle the `app-update.yml` electron-updater
// reads at startup.
//
// electron-builder writes that file itself only when the mac targets include `dmg` or `zip`
// (PublishManager's afterPack handler). The release job packs with `--mac --dir`, so its target
// list is just `dir` and the file was never written: every shipped `.app` logged `ENOENT …
// app-update.yml` a minute after launch and every self-update fell back to the release page
// (#1431). afterPack runs before electron-builder signs the bundle, and before build.yml's ad-hoc
// signing, so the file is sealed into the signature like any other resource.
//
// macOS only on purpose. Windows gets the file from nsis, and the Store (appx) build must NOT get
// one — see the `publish` comment in electron-builder.json5. Linux writes it per target in fpm.

const fs = require("node:fs");
const path = require("node:path");

/** The YAML electron-builder would have written: the first publish config + the cache dir. */
function appUpdateYaml(publish, updaterCacheDirName) {
	const config = { ...publish, updaterCacheDirName };
	return Object.entries(config)
		.map(([key, value]) => `${key}: ${value}\n`)
		.join("");
}

exports.default = async function afterPack(context) {
	if (context.electronPlatformName !== "darwin") return;
	const { packager } = context;
	const file = path.join(packager.getResourcesDir(context.appOutDir), "app-update.yml");
	if (fs.existsSync(file)) return;
	const [publish] = [packager.config.publish ?? []].flat();
	if (publish == null) throw new Error("afterPack: no publish config to write app-update.yml from");
	fs.writeFileSync(file, appUpdateYaml(publish, packager.appInfo.updaterCacheDirName));
	console.log(`  • wrote ${path.relative(context.appOutDir, file)}`);
};
