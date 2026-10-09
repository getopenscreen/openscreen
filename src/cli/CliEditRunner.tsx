import { useEffect, useRef, useState } from "react";
import type { EditorFileSession } from "@/components/ai-edition/fileSession";
import { NewEditorShell } from "@/components/ai-edition/NewEditorShell";

export default function CliEditRunner() {
	const started = useRef(false);
	const [fileSession, setFileSession] = useState<EditorFileSession>();
	useEffect(() => {
		if (started.current) return;
		started.current = true;
		const fail = (error: unknown) => {
			void window.electronAPI.cliDone({
				success: false,
				error: error instanceof Error ? error.message : String(error),
			});
		};
		void (async () => {
			try {
				const request = await window.electronAPI.cliGetRequest();
				if (request.kind !== "edit") {
					throw new Error(`cli-edit window received a ${request.kind} request`);
				}
				const { projectPath, outPath } = request;
				setFileSession({
					projectPath,
					onLoadError: fail,
					onFinish: async (document) => {
						await window.electronAPI.cliDone({
							success: true,
							projectPath: outPath ?? projectPath,
							projectData: document,
						});
					},
				});
			} catch (error) {
				fail(error);
			}
		})();
	}, []);
	return fileSession ? <NewEditorShell fileSession={fileSession} /> : null;
}
