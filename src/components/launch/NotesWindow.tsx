import React, { useLayoutEffect, useState } from "react";
import { useScopedT } from "@/contexts/I18nContext";

export function NotesWindow() {
	const t = useScopedT("launch");
	const [notes, setNotes] = useState("");

	const handleNotesChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
		localStorage.setItem("notes", e.target.value);
		setNotes(e.target.value);
	};

	useLayoutEffect(() => {
		setNotes(localStorage.getItem("notes") ?? "");
	}, []);

	return (
		<div className="bg-white h-screen w-screen px-6 py-4">
			<textarea
				className="w-full h-full bg-transparent outline-none resize-none caret-black text-black"
				placeholder={t("tooltips.openNotesPlaceholder")}
				value={notes}
				onChange={handleNotesChange}
			/>
		</div>
	);
}
