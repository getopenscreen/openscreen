import React, { useState } from "react";

export function NotesWindow() {
	const [notes, setNotes] = useState("");

	const handleNotesChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
		setNotes(e.target.value);
	};

	return (
		<div className="bg-red-900 h-screen w-screen ">
			<textarea
				className="w-full h-full bg-transparent outline-none resize-none"
				placeholder="Take notes here..."
				value={notes}
				onChange={handleNotesChange}
			/>
		</div>
	);
}
