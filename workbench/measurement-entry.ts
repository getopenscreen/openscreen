import { runMeasurementCli } from "./measurement-cli";

void runMeasurementCli(process.argv.slice(2)).then((code) => {
	process.exitCode = code;
});
