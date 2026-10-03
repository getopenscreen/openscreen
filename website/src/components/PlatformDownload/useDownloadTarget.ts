import { useEffect, useState } from "react";

import {
	type BrowserNavigator,
	browserDownloadTarget,
	type DownloadTarget,
	downloadTarget,
} from "../../lib/download-target";

function macRenderer(): string {
	const canvas = document.createElement("canvas");
	const gl = canvas.getContext("webgl");
	if (!gl) return "";
	try {
		const debug = gl.getExtension("WEBGL_debug_renderer_info");
		return debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : "";
	} finally {
		gl.getExtension("WEBGL_lose_context")?.loseContext();
	}
}

export default function useDownloadTarget(): DownloadTarget {
	const [target, setTarget] = useState<DownloadTarget>({ os: null, kind: null });
	useEffect(() => {
		let active = true;
		const nav = navigator as BrowserNavigator;
		setTarget(
			downloadTarget({
				userAgent: nav.userAgent,
				platform: nav.platform,
				maxTouchPoints: nav.maxTouchPoints,
				uaPlatform: nav.userAgentData?.platform,
				mobile: nav.userAgentData?.mobile,
			}),
		);
		void browserDownloadTarget(nav, macRenderer).then((detected) => {
			if (active) setTarget(detected);
		});
		return () => {
			active = false;
		};
	}, []);
	return target;
}
