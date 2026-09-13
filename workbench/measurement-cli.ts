import {
	assertComparable,
	boundBaselineFromMeasurement,
	exportMeasurement,
	MeasurementError,
	replayMeasurement,
	verifyMeasurementId,
	writeBoundBaseline,
} from "./lib/measurement";
import { newcombeDelta } from "./lib/stats";

type Command = "export" | "verify" | "replay" | "baseline" | "compare" | "help";

interface ParsedArgs {
	command: Command;
	values: Map<string, string>;
}

const CONTRACT: Record<Exclude<Command, "help">, string[]> = {
	export: ["--run", "--id", "--review"],
	verify: ["--id"],
	replay: ["--id"],
	baseline: ["--id", "--out"],
	compare: ["--left", "--right"],
};

function parseArgs(argv: string[]): ParsedArgs {
	const rawCommand = argv[0];
	if (!rawCommand || rawCommand === "help" || rawCommand === "--help") {
		return { command: "help", values: new Map() };
	}
	if (!(rawCommand in CONTRACT)) {
		throw new MeasurementError("ARGUMENT_ERROR", `unknown command: ${rawCommand}`);
	}
	const command = rawCommand as Exclude<Command, "help">;
	const expected = new Set(CONTRACT[command as Exclude<Command, "help">]);
	const values = new Map<string, string>();
	for (let index = 1; index < argv.length; index += 2) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (!expected.has(flag) || value === undefined || value.startsWith("--")) {
			throw new MeasurementError(
				"ARGUMENT_ERROR",
				`invalid or missing value for ${flag ?? "argument"}`,
			);
		}
		if (values.has(flag)) throw new MeasurementError("ARGUMENT_ERROR", `duplicate flag: ${flag}`);
		values.set(flag, value);
	}
	for (const flag of expected) {
		if (!values.has(flag)) throw new MeasurementError("ARGUMENT_ERROR", `${flag} is required`);
	}
	return { command: command as Command, values };
}

function value(args: ParsedArgs, flag: string): string {
	const found = args.values.get(flag);
	if (!found) throw new MeasurementError("ARGUMENT_ERROR", `${flag} is required`);
	return found;
}

function printHelp(): void {
	process.stdout.write(
		[
			"workbench measurement evidence",
			"",
			"  export   --run <run-dir> --id <id> --review <review-json>",
			"  verify   --id <id>",
			"  replay   --id <id>",
			"  baseline --id <id> --out <candidate-json>",
			"  compare  --left <id> --right <id>",
			"",
			"Commands are offline and do not read provider credentials or call remote services.",
		].join("\n") + "\n",
	);
}

function logJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function runMeasurementCli(argv: string[]): Promise<number> {
	try {
		const args = parseArgs(argv);
		switch (args.command) {
			case "export": {
				const directory = exportMeasurement({
					runDir: value(args, "--run"),
					id: value(args, "--id"),
					reviewFile: value(args, "--review"),
				});
				logJson({ ok: true, command: "export", directory });
				return 0;
			}
			case "verify": {
				const verified = verifyMeasurementId(value(args, "--id"));
				logJson({
					ok: true,
					command: "verify",
					id: verified.manifest.id,
					disposition: verified.review.disposition,
					results: verified.manifest.results,
				});
				return 0;
			}
			case "replay": {
				const counts = await replayMeasurement(value(args, "--id"));
				logJson({ ok: true, command: "replay", counts });
				return 0;
			}
			case "baseline": {
				const verified = verifyMeasurementId(value(args, "--id"));
				const baseline = boundBaselineFromMeasurement(verified);
				const out = value(args, "--out");
				writeBoundBaseline(out, baseline);
				logJson({ ok: true, command: "baseline", out, measurementId: baseline.measurementId });
				return 0;
			}
			case "compare": {
				const left = verifyMeasurementId(value(args, "--left"));
				const right = verifyMeasurementId(value(args, "--right"));
				try {
					assertComparable(left.manifest, right.manifest);
				} catch (error) {
					if (error instanceof MeasurementError) {
						logJson({
							ok: false,
							comparable: false,
							code: error.code,
							left: {
								counts: left.manifest.results.axes,
								scores: left.manifest.results.axisScores,
							},
							right: {
								counts: right.manifest.results.axes,
								scores: right.manifest.results.axisScores,
							},
						});
					}
					throw error;
				}
				logJson({
					ok: true,
					command: "compare",
					comparable: true,
					leftScores: left.manifest.results.axisScores,
					rightScores: right.manifest.results.axisScores,
					behaviour: newcombeDelta(
						{
							k: left.manifest.results.axes.behaviour.passed,
							n: left.manifest.results.axes.behaviour.decided,
						},
						{
							k: right.manifest.results.axes.behaviour.passed,
							n: right.manifest.results.axes.behaviour.decided,
						},
					),
					dsl: newcombeDelta(
						{
							k: left.manifest.results.axes.dsl.passed,
							n: left.manifest.results.axes.dsl.decided,
						},
						{
							k: right.manifest.results.axes.dsl.passed,
							n: right.manifest.results.axes.dsl.decided,
						},
					),
				});
				return 0;
			}
			default:
				printHelp();
				return 0;
		}
	} catch (error) {
		const code = error instanceof MeasurementError ? error.code : "MANIFEST_INVALID";
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`${code}: ${message}\n`);
		return 1;
	}
}
