// The process's real stdin. On Windows, Electron's main process gets a
// `process.stdin` that ends at once whatever the parent piped in (measured with
// Electron 41), so a pipe has to be read from descriptor 0 directly.

import net from "node:net";
import type { Readable } from "node:stream";

export function openStdin(): Readable {
	if (process.platform !== "win32") return process.stdin;
	try {
		return new net.Socket({ fd: 0, readable: true, writable: false });
	} catch {
		// Not a pipe (a console, or nothing at all): no one can write to us anyway.
		return process.stdin;
	}
}
