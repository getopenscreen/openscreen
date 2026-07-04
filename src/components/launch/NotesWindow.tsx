import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { NotesToolbar } from "./NotesToolbar";
import "./NotesWindow.module.css";

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
		<div className="flex h-screen w-screen flex-col overflow-hidden bg-white px-6 pb-4 pt-3 gap-4">
			<div className="shrink-0 flex justify-center">
				<NotesToolbar editor={editor} />
			</div>

			<EditorContent editor={editor} className="min-h-0 flex-1" />
		</div>
	);
}
