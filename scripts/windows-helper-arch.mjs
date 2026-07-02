// Pure helpers that map a target CPU architecture to the parameters the Windows
// native-helper build needs. Kept side-effect free so it is unit-testable and
// importable from both the build script and Vitest.

export const SUPPORTED_ARCHES = ["x64", "arm64"];

const ALIASES = new Map([
	["x64", "x64"],
	["amd64", "x64"],
	["x86_64", "x64"],
	["arm64", "arm64"],
	["aarch64", "arm64"],
]);

export function normalizeArch(value) {
	if (value === undefined || value === null || value === "") {
		return undefined;
	}
	return ALIASES.get(String(value).toLowerCase());
}

export function resolveTargetArch({ cliArch, envArch, hostArch } = {}) {
	for (const [label, raw] of [
		["--arch", cliArch],
		["OPENSCREEN_WIN_HELPER_ARCH", envArch],
	]) {
		if (raw !== undefined && raw !== null && raw !== "") {
			const normalized = normalizeArch(raw);
			if (!normalized) {
				throw new Error(
					`Invalid ${label} value "${raw}". Expected one of: ${SUPPORTED_ARCHES.join(", ")}.`,
				);
			}
			return normalized;
		}
	}

	const host = normalizeArch(hostArch);
	if (!host) {
		throw new Error(
			`Unsupported host architecture "${hostArch}". Pass --arch with one of: ${SUPPORTED_ARCHES.join(", ")}.`,
		);
	}
	return host;
}

export function resolveVcvarsArch(hostArch, targetArch) {
	const host = normalizeArch(hostArch);
	const target = normalizeArch(targetArch);
	if (!host || !target) {
		throw new Error(`Unsupported architecture pair host="${hostArch}" target="${targetArch}".`);
	}
	return host === target ? target : `${host}_${target}`;
}

export function winBinDirName(targetArch) {
	const target = normalizeArch(targetArch);
	if (!target) {
		throw new Error(`Unsupported target architecture "${targetArch}".`);
	}
	return `win32-${target}`;
}
