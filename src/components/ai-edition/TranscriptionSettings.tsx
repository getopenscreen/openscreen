// The transcription section of AI settings: whether media is transcribed in the
// background as soon as it lands in a project. The first run downloads the
// Whisper model from huggingface.co, so this switch is also what keeps the app
// off the network for someone who never asks for a transcript (issue #1419).
// The preference is machine-wide (userPreferences), not per project; the
// transcription store owns it, so this reads and writes it there.

import { useScopedT } from "@/contexts/I18nContext";
import { useTranscriptionStore } from "@/lib/ai-edition/store/transcriptionStore";
import { ToggleField } from "./McpServerSettings";
import styles from "./NewEditorShell.module.css";

export function TranscriptionSettings() {
	const te = useScopedT("editor");
	const autoTranscribe = useTranscriptionStore((s) => s.autoTranscribe);
	const setAutoTranscribe = useTranscriptionStore((s) => s.setAutoTranscribe);

	return (
		<section
			data-testid="transcription-settings"
			style={{
				marginTop: 20,
				paddingTop: 16,
				borderTop: "1px solid var(--line, rgba(127,127,127,0.2))",
			}}
		>
			<div className={styles.providerForm} style={{ padding: 0 }}>
				<div className={styles.title}>
					<h3>{te("transcriptionSettings.title")}</h3>
				</div>
				<ToggleField
					label={te("transcriptionSettings.autoLabel")}
					text={te("transcriptionSettings.auto")}
					hint={te("transcriptionSettings.autoHint")}
					testId="auto-transcribe-toggle"
					on={autoTranscribe}
					disabled={false}
					onToggle={() => setAutoTranscribe(!autoTranscribe)}
				/>
			</div>
		</section>
	);
}
