// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { withTranscript } from "@/lib/ai-edition/document/transcript";
import { documentSchema } from "@/lib/ai-edition/schema";
import * as projectWrites from "@/lib/ai-edition/store/projectStore";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { useTranscriptionStore } from "@/lib/ai-edition/store/transcriptionStore";
import { redo, undo } from "@/lib/ai-edition/store/undo";
import { clearHistory, past } from "@/lib/ai-edition/store/undoStack";
import { transcriptFromSrt } from "@/lib/ai-edition/transcription/fromSrt";
import { ImportSrtDialog } from "./ImportSrtDialog";

const mocks = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock("@/native/client", () => ({ nativeBridgeClient: { aiEdition: { save: mocks.save } } }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
const text = "1\n00:00:00,000 --> 00:00:01,000\nHello world";
function doc() {
	return documentSchema.parse({
		schemaVersion: 9,
		project: {
			id: "p",
			title: "P",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			primaryAssetId: "a",
		},
		assets: [
			{ id: "a", label: "Recording", originalPath: "/a.mp4", durationSec: 4, kind: "video" },
			{ id: "b", label: "Voiceover", originalPath: "/b.wav", durationSec: 4, kind: "audio" },
		],
		timeline: { clips: [] },
		transcripts: [],
		audioTracks: [{ id: "v", assetId: "b", kind: "voiceover", startMs: 0, endMs: 4000 }],
	});
}
function show() {
	return render(
		<I18nProvider>
			<ImportSrtDialog onClose={vi.fn()} />
		</I18nProvider>,
	);
}
function file(content = text) {
	fireEvent.change(screen.getByLabelText("SRT file"), {
		target: { files: [{ name: "example.srt", text: () => Promise.resolve(content) }] },
	});
}
beforeEach(() => {
	clearHistory();
	useProjectStore.setState({ projectId: "p", document: doc() });
	useTranscriptionStore.setState({ projectId: "p", jobs: {} });
	mocks.save.mockImplementation(async (document) => ({ success: true, document }));
});
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});
it("requires an explicit asset and saves only that transcript with history and provenance", async () => {
	show();
	expect(screen.getByRole("button", { name: "Import" })).toBeDisabled();
	fireEvent.change(screen.getByLabelText("Target media"), { target: { value: "b" } });
	file();
	fireEvent.click(screen.getByRole("button", { name: "Import" }));
	await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
	await waitFor(() => expect(useProjectStore.getState().document?.transcripts).toHaveLength(1));
	expect(useProjectStore.getState().document?.transcripts[0].assetId).toBe("b");
	expect(useProjectStore.getState().document?.transcript).toBeNull();
	expect(past).toHaveLength(1);
	expect(undo()).toBe(true);
	expect(useProjectStore.getState().document?.transcripts).toHaveLength(0);
	expect(redo()).toBe(true);
	expect(useProjectStore.getState().document?.transcripts[0].importSource?.fileName).toBe(
		"example.srt",
	);
	expect(useProjectStore.getState().document?.timeline).toEqual(doc().timeline);
});
it("validates the entire file before replacing existing text", async () => {
	const d = doc();
	d.transcripts = [transcriptFromSrt("a", text, 4, "old.srt")];
	useProjectStore.setState({ document: d });
	show();
	fireEvent.change(screen.getByLabelText("Target media"), { target: { value: "a" } });
	file("bad");
	fireEvent.click(screen.getByRole("button", { name: "Import" }));
	await screen.findByRole("alert");
	expect(mocks.save).not.toHaveBeenCalled();
	expect(useProjectStore.getState().document?.transcripts).toEqual(d.transcripts);
});
it("asks to replace and rejects transcript changes while awaiting confirmation", async () => {
	const d = doc();
	d.transcripts = [transcriptFromSrt("a", text, 4, "old.srt")];
	useProjectStore.setState({ document: d });
	show();
	fireEvent.change(screen.getByLabelText("Target media"), { target: { value: "a" } });
	file();
	fireEvent.click(screen.getByRole("button", { name: "Import" }));
	const replace = await screen.findByRole("button", { name: "Replace transcript" });
	useProjectStore.setState({
		document: { ...d, transcripts: [transcriptFromSrt("a", text, 4, "new.srt")] },
	});
	fireEvent.click(replace);
	await screen.findByRole("alert");
	expect(mocks.save).not.toHaveBeenCalled();
});
it("disables a queued transcription target", () => {
	useTranscriptionStore.setState({
		jobs: { a: { status: "queued", language: "auto", manual: false } },
	});
	show();
	expect(screen.getByRole("option", { name: /Recording/ })).toBeDisabled();
});

it("abandons a file read when the dialog unmounts", async () => {
	let resolve!: (text: string) => void;
	const view = show();
	fireEvent.change(screen.getByLabelText("Target media"), { target: { value: "a" } });
	fireEvent.change(screen.getByLabelText("SRT file"), {
		target: {
			files: [
				{
					name: "example.srt",
					text: () =>
						new Promise<string>((r) => {
							resolve = r;
						}),
				},
			],
		},
	});
	fireEvent.click(screen.getByRole("button", { name: "Import" }));
	view.unmount();
	resolve(text);
	await new Promise((r) => setTimeout(r, 0));
	expect(mocks.save).not.toHaveBeenCalled();
});
it.each(["project", "removed", "busy"])("refuses a stale %s after reading", async (change) => {
	let resolve!: (text: string) => void;
	show();
	fireEvent.change(screen.getByLabelText("Target media"), { target: { value: "a" } });
	fireEvent.change(screen.getByLabelText("SRT file"), {
		target: {
			files: [
				{
					name: "example.srt",
					text: () =>
						new Promise<string>((r) => {
							resolve = r;
						}),
				},
			],
		},
	});
	fireEvent.click(screen.getByRole("button", { name: "Import" }));
	const d = useProjectStore.getState().document!;
	if (change === "project")
		useProjectStore.setState({
			projectId: "other",
			document: { ...d, project: { ...d.project, id: "other" } },
		});
	if (change === "removed")
		useProjectStore.setState({ document: { ...d, assets: d.assets.filter((a) => a.id !== "a") } });
	if (change === "busy")
		useTranscriptionStore.setState({
			jobs: { a: { status: "running", language: "auto", manual: false } },
		});
	resolve(text);
	await screen.findByRole("alert");
	expect(mocks.save).not.toHaveBeenCalled();
});
it("reports failed saves without adding history or replacing text", async () => {
	mocks.save.mockResolvedValue({ success: false, error: "disk full" });
	const before = useProjectStore.getState().document;
	show();
	fireEvent.change(screen.getByLabelText("Target media"), { target: { value: "a" } });
	file();
	fireEvent.click(screen.getByRole("button", { name: "Import" }));
	expect(await screen.findByRole("alert")).toHaveTextContent("Could not save");
	expect(past).toHaveLength(0);
	expect(useProjectStore.getState().document).toBe(before);
});
it("imports the primary transcript only after explicit replacement confirmation", async () => {
	const d = doc();
	const old = transcriptFromSrt("a", text, 4, "old.srt");
	d.transcript = old;
	d.transcripts = [old];
	useProjectStore.setState({ document: d });
	show();
	fireEvent.change(screen.getByLabelText("Target media"), { target: { value: "a" } });
	file();
	fireEvent.click(screen.getByRole("button", { name: "Import" }));
	const replace = await screen.findByRole("button", { name: "Replace transcript" });
	expect(mocks.save).not.toHaveBeenCalled();
	fireEvent.click(replace);
	await waitFor(() => expect(past).toHaveLength(1));
	const saved = useProjectStore.getState().document!;
	expect(saved.transcript).toEqual(saved.transcripts[0]);
	expect(saved.transcript?.importSource?.fileName).toBe("example.srt");
	expect(saved.assets).toEqual(d.assets);
	expect(saved.audioTracks).toEqual(d.audioTracks);
});

it("waits for an existing B save then merges A into the latest saved document", async () => {
	let finish!: () => void;
	mocks.save.mockImplementationOnce(async (document) => {
		await new Promise<void>((resolve) => {
			finish = resolve;
		});
		return { success: true, document };
	});
	const old = useProjectStore.getState().document!;
	const b = useProjectStore
		.getState()
		.saveDocument(withTranscript(old, transcriptFromSrt("b", text, 4, "b.srt")), {
			history: false,
		});
	show();
	fireEvent.change(screen.getByLabelText("Target media"), { target: { value: "a" } });
	file();
	fireEvent.click(screen.getByRole("button", { name: "Import" }));
	await new Promise((resolve) => setTimeout(resolve, 0));
	const count = mocks.save.mock.calls.length;
	finish();
	await b;
	await waitFor(() => expect(useProjectStore.getState().document?.transcripts).toHaveLength(2));
	expect(count).toBe(1);
	expect(
		mocks.save.mock.calls
			.at(-1)?.[0]
			.transcripts.map((t: { assetId: string }) => t.assetId)
			.sort(),
	).toEqual(["a", "b"]);
});

it("abandons import when existing document saves time out", async () => {
	const wait = vi.spyOn(projectWrites, "waitForDocumentSaves").mockResolvedValueOnce("timeout");
	show();
	fireEvent.change(screen.getByLabelText("Target media"), { target: { value: "a" } });
	file();
	fireEvent.click(screen.getByRole("button", { name: "Import" }));
	await waitFor(() => expect(wait).toHaveBeenCalled());
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(mocks.save).not.toHaveBeenCalled();
	wait.mockRestore();
});
it.each([
	"close",
	"unmount",
])("cancels before dispatching import on %s while another save is pending", async (mode) => {
	let finish!: () => void;
	mocks.save.mockImplementationOnce(async (document) => {
		await new Promise<void>((resolve) => {
			finish = resolve;
		});
		return { success: true, document };
	});
	const b = useProjectStore
		.getState()
		.saveDocument(useProjectStore.getState().document!, { history: false });
	const view = show();
	fireEvent.change(screen.getByLabelText("Target media"), { target: { value: "a" } });
	file();
	fireEvent.click(screen.getByRole("button", { name: "Import" }));
	await new Promise((resolve) => setTimeout(resolve, 0));
	if (mode === "unmount") view.unmount();
	else fireEvent.click(screen.getByRole("button", { name: "Close" }));
	finish();
	await b;
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(mocks.save).toHaveBeenCalledTimes(1);
	expect(useProjectStore.getState().document?.transcripts).toHaveLength(0);
});
