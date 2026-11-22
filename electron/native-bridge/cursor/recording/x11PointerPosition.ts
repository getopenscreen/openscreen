import { execFile } from "node:child_process";
import { screen } from "electron";

/** A fresh read-only XQueryPointer via xdotool; never move or synthesize input. */
export function readX11PointerPosition(): Promise<{ x: number; y: number }> {
	return new Promise((resolve, reject) => {
		execFile(
			"xdotool",
			["getmouselocation", "--shell"],
			{ timeout: 250, maxBuffer: 4096, encoding: "utf8" },
			(error, stdout) => {
				if (error) return reject(error);
				const x = /^X=(-?\d+)\r?$/m.exec(stdout);
				const y = /^Y=(-?\d+)\r?$/m.exec(stdout);
				if (!x || !y) return reject(new Error("X11 pointer query returned no position"));
				try {
					// XQueryPointer is pixels; Electron's captured display bounds are DIP.
					const point = screen.screenToDipPoint({ x: Number(x[1]), y: Number(y[1]) });
					if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
						return reject(new Error("X11 pointer conversion returned an invalid point"));
					}
					resolve(point);
				} catch (error) {
					reject(error);
				}
			},
		);
	});
}
