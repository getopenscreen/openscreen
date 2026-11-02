// `openscreen cursor import`: write a version-2 `<video>.cursor.json` sidecar
// from an external mouse CSV (and optional click timestamps). File-only, like
// `pack` and `info` — no renderer window.

import { writeCursorSidecarFromCsv } from "../media/cursorTelemetryImport";
import type { CliWriter } from "./projectCommands";

export interface CursorImportRequest {
	csvPath: string;
	clicksPath: string | null;
	videoPath: string | null;
	outputPath: string | null;
	width: number;
	height: number;
	clickHoldMs: number;
}

export async function runCursorImportCommand(
	request: CursorImportRequest,
	json: boolean,
	out: CliWriter,
): Promise<number> {
	const { outputPath, data } = await writeCursorSidecarFromCsv(request);
	const clicks = data.samples.filter((sample) => sample.interactionType === "click").length;
	const mouseups = data.samples.filter((sample) => sample.interactionType === "mouseup").length;
	const moves = data.samples.length - clicks - mouseups;
	if (json) {
		out(
			`${JSON.stringify({
				event: "done",
				success: true,
				outputPath,
				samples: data.samples.length,
				moves,
				clicks,
				mouseups,
			})}\n`,
		);
	} else {
		out(`Wrote ${outputPath}\n`);
		out(`  samples=${data.samples.length} moves=${moves} clicks=${clicks} mouseups=${mouseups}\n`);
	}
	return 0;
}
