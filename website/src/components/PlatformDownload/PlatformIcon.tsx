import { Download } from "lucide-react";

import type { DownloadTarget } from "../../lib/download-target";
// Apple and Tux paths from Simple Icons, distributed under CC0.
import AppleIcon from "./apple.svg";
import LinuxIcon from "./linux.svg";

export default function PlatformIcon({ os }: { os: DownloadTarget["os"] }) {
	if (os === "macos")
		return <AppleIcon width={16} height={16} fill="currentColor" aria-hidden="true" />;
	if (os === "linux")
		return <LinuxIcon width={16} height={16} fill="currentColor" aria-hidden="true" />;
	if (os === "windows")
		return (
			<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
				<path d="M2 2h9v9H2zm11 0h9v9h-9zM2 13h9v9H2zm11 0h9v9h-9z" />
			</svg>
		);
	return <Download size={16} aria-hidden="true" />;
}
