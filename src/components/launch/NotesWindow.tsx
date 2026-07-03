import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import styles from "./NotesWindow.module.css";

function getInitialNotesContent(): string {
	const stored = localStorage.getItem("notes");
	if (!stored) {
		return "";
	}

	// Notes saved before Tiptap were plain text; wrap so StarterKit can parse them.
	if (!stored.trim().startsWith("<")) {
		const escaped = stored.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
		return `<p>${escaped.replace(/\n/g, "</p><p>")}</p>`;
	}

	return stored;
}

export function NotesWindow() {
	const editor = useEditor({
		extensions: [StarterKit],
		content: getInitialNotesContent(),
		autofocus: "end",
		editorProps: {
			attributes: {
				class: "tiptap",
			},
		},
		onUpdate: ({ editor: nextEditor }) => {
			localStorage.setItem("notes", nextEditor.getHTML());
		},
	});

	return (
		<div className={styles.notesWindow}>
			<EditorContent editor={editor} className={styles.notesEditor} />
		</div>
	);
}
