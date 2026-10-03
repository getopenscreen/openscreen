import { type AssetKind, findAsset, type LatestRelease } from "./release.ts";

export const STORE_URL = "https://apps.microsoft.com/detail/9MXQ1HQJL5G5";
// The endpoint used by Microsoft's own Store badge in direct-install mode.
export const STORE_INSTALLER_URL = "https://get.microsoft.com/installer/download/9MXQ1HQJL5G5";

export type DownloadTarget = {
	os: "macos" | "windows" | "linux" | null;
	kind: AssetKind | null;
};

export type BrowserSignals = {
	userAgent: string;
	platform?: string;
	maxTouchPoints?: number;
	mobile?: boolean;
	uaPlatform?: string;
	architecture?: string;
	macRenderer?: string;
};

/** The UA's "Intel Mac" token is also used on Apple Silicon and is not a CPU hint. */
export function downloadTarget(signals: BrowserSignals): DownloadTarget {
	const { userAgent, platform = "", uaPlatform = "", architecture = "" } = signals;
	const unsupported = { os: null, kind: null };
	if (
		signals.mobile ||
		/Android|iPhone|iPad|iPod|CrOS|Windows Phone|Mobile/i.test(userAgent) ||
		(/Mac/i.test(platform) && (signals.maxTouchPoints ?? 0) > 1)
	) {
		return unsupported;
	}

	if (/Windows/i.test(uaPlatform) || /Win/i.test(platform) || /Windows NT/i.test(userAgent)) {
		return { os: "windows", kind: null };
	}
	if (/macOS/i.test(uaPlatform) || /Mac/i.test(platform) || /Macintosh/i.test(userAgent)) {
		const renderer = signals.macRenderer ?? "";
		if (/^arm|aarch64/i.test(architecture) || /Apple (?:M\d|Silicon)/i.test(renderer)) {
			return { os: "macos", kind: "macArm" };
		}
		if (/^x86|^x64|^amd64/i.test(architecture) || /Intel|AMD|Radeon|NVIDIA/i.test(renderer)) {
			return { os: "macos", kind: "macIntel" };
		}
		return { os: "macos", kind: null };
	}
	if (/Linux/i.test(uaPlatform) || /Linux/i.test(platform) || /Linux/i.test(userAgent)) {
		// Linux releases currently ship for x64 only. Never offer one to a known ARM host.
		if (
			/^arm|aarch64/i.test(architecture) ||
			/aarch64|armv\d|\bi[3-6]86\b/i.test(`${userAgent} ${platform}`)
		) {
			return { os: "linux", kind: null };
		}
		if (/\b(?:Debian|Ubuntu|Linux Mint|Pop!_OS)\b/i.test(userAgent)) {
			return { os: "linux", kind: "deb" };
		}
		if (/\b(?:Fedora|Red Hat|RHEL|CentOS)\b/i.test(userAgent)) {
			return { os: "linux", kind: "rpm" };
		}
		if (/\b(?:Arch(?: Linux|Linux)?|Manjaro)\b/i.test(userAgent)) {
			return { os: "linux", kind: "pacman" };
		}
		return { os: "linux", kind: "appImage" };
	}
	return unsupported;
}

export type BrowserNavigator = Pick<Navigator, "userAgent" | "platform" | "maxTouchPoints"> & {
	userAgentData?: {
		platform?: string;
		mobile?: boolean;
		getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string }>;
	};
};

/** Ask only for architecture, and keep working when hints or WebGL are unavailable. */
export async function browserDownloadTarget(
	nav: BrowserNavigator,
	macRenderer: () => string = () => "",
): Promise<DownloadTarget> {
	const signals: BrowserSignals = {
		userAgent: nav.userAgent,
		platform: nav.platform,
		maxTouchPoints: nav.maxTouchPoints,
		uaPlatform: nav.userAgentData?.platform,
		mobile: nav.userAgentData?.mobile,
	};
	const initial = downloadTarget(signals);
	if (initial.os !== "macos" && initial.os !== "linux") return initial;
	try {
		const hints = await nav.userAgentData?.getHighEntropyValues?.(["architecture"]);
		signals.architecture = hints?.architecture;
	} catch {
		// A browser can decline hints without preventing the download chooser.
	}
	if (initial.os === "macos" && !/^arm|aarch64/i.test(signals.architecture ?? "")) {
		try {
			signals.macRenderer = macRenderer();
		} catch {
			// Privacy settings can hide the renderer; show the two Mac versions instead.
		}
	}
	return downloadTarget(signals);
}

export function directDownloadUrl(target: DownloadTarget, release: LatestRelease): string | null {
	if (target.os === "windows") return STORE_INSTALLER_URL;
	return target.kind ? (findAsset(release, target.kind)?.url ?? null) : null;
}
