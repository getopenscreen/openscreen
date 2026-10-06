// @vitest-environment jsdom
// The chat panel's icon-only controls name themselves in the shared tooltip, not in a native
// `title`. Rewind and Compact say what they do, Send shows Enter as a chip, and a button that is
// greyed for now (Send with no provider, Compact with no conversation) still opens its tooltip:
// that is where "Set up a provider" is said, and a natively disabled button takes no pointer
// events, so it uses `aria-disabled`.

import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const snapshot = vi.hoisted(() => ({
	value: {
		config: null as { provider: string; model: string } | null,
		connectedProviders: [] as string[],
		availableProviders: [] as unknown[],
		credentialSummary: [] as unknown[],
	},
}));
const sessions = vi.hoisted(() => ({ list: [] as unknown[] }));
const chatCompact = vi.hoisted(() => vi.fn());

vi.mock("@/native/client", () => ({
	nativeBridgeClient: {
		aiEdition: {
			llmGetSnapshot: () => Promise.resolve(snapshot.value),
			chatListSessions: () => Promise.resolve(sessions.list),
			chatSelectSession: () =>
				Promise.resolve({
					id: "session-1",
					projectId: "project-1",
					title: "Conversation 1",
					createdAt: "2026-09-23T00:00:00Z",
					updatedAt: "2026-09-23T00:00:00Z",
					messages: [
						{
							id: "m1",
							role: "user",
							content: "Cut the silences",
							checkpointId: "cp1",
							createdAt: "2026-09-23T00:00:01Z",
						},
						{
							id: "m2",
							role: "assistant",
							content: "Done",
							createdAt: "2026-09-23T00:00:02Z",
						},
					],
				}),
			chatBudget: () => Promise.resolve(null),
			chatCompact,
			llmListProviderModels: () => Promise.resolve({ models: [] }),
		},
	},
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

// An echoing translator: the assertions read against keys, not prose that drifts with copy edits.
vi.mock("@/contexts/I18nContext", () => ({
	useI18n: () => ({ locale: "en", setLocale: vi.fn() }),
	useScopedT: () => (key: string) => key,
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import { EditorDialogsProvider } from "@/contexts/EditorDialogsContext";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { ChatStripPanel } from "./LeftPanel";

class StubResizeObserver {
	observe = vi.fn();
	unobserve = vi.fn();
	disconnect = vi.fn();
}

const oneSession = [
	{ id: "session-1", title: "Conversation 1", messageCount: 2, createdAt: "2026-09-23T00:00:00Z" },
];

beforeEach(() => {
	vi.stubGlobal("ResizeObserver", StubResizeObserver);
	// jsdom implements no scrolling, and the transcript pins itself to the bottom on every render.
	Element.prototype.scrollTo = vi.fn();
	(window as unknown as { electronAPI?: unknown }).electronAPI = {
		onAiEditionChatEvent: () => vi.fn(),
	};
	useProjectStore.setState({ projectId: "project-1" });
	snapshot.value = {
		config: null,
		connectedProviders: [],
		availableProviders: [],
		credentialSummary: [],
	};
	sessions.list = [];
	chatCompact.mockClear();
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	(window as unknown as { electronAPI?: unknown }).electronAPI = undefined;
});

function renderPanel() {
	return render(
		<TooltipProvider>
			<EditorDialogsProvider>
				<ChatStripPanel />
			</EditorDialogsProvider>
		</TooltipProvider>,
	);
}

/** Opens a control's tooltip the way the keyboard does (focus opens it at once) and returns what
 *  it says and whether it shows a shortcut chip. */
async function tooltipOn(control: HTMLElement) {
	// A keyboard focus: one the mouse gave opens no tooltip.
	fireEvent.keyDown(window, { key: "Tab" });
	act(() => control.focus());
	const text = (await screen.findByRole("tooltip")).textContent;
	const chip = document.querySelector('[data-slot="tooltip-content"] kbd')?.textContent ?? null;
	act(() => control.blur());
	await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
	return { text, chip };
}

describe("ChatStripPanel tooltips", () => {
	it("names the header buttons in the shared tooltip, with no native title", async () => {
		sessions.list = oneSession;
		renderPanel();
		await screen.findByRole("button", { name: "chat.deleteConversation" });

		for (const name of [
			"chat.compactContext",
			"chat.aiSettings",
			"chat.history",
			"chat.newConversation",
			"chat.renameConversation",
			"chat.deleteConversation",
		]) {
			const button = screen.getByRole("button", { name });
			expect(button).not.toHaveAttribute("title");
			expect((await tooltipOn(button)).text).toBe(name);
		}
	});

	// Plain text has no interactive element to hold a tooltip, so its hint stays native.
	it("keeps the native title only on plain text", async () => {
		sessions.list = oneSession;
		renderPanel();
		expect(await screen.findByTitle("chat.clickToRename")).toBeInTheDocument();
	});

	it("says what Rewind does, not only what the button is called", async () => {
		sessions.list = oneSession;
		renderPanel();
		const rewind = await screen.findByRole("button", { name: "chat.rewindToMessage" });
		expect(rewind).not.toHaveAttribute("title");
		expect((await tooltipOn(rewind)).text).toBe("chat.rewindTip");
	});

	it("names Copy in the shared tooltip too", async () => {
		sessions.list = oneSession;
		renderPanel();
		const [copy] = await screen.findAllByRole("button", { name: "chat.copyMessage" });
		expect(copy).not.toHaveAttribute("title");
		expect((await tooltipOn(copy)).text).toBe("chat.copyMessage");
	});

	// Nothing to talk to yet: Send is greyed, but it is where the reason is said.
	it("says why Send is off when no provider is set up, and shows no chip then", async () => {
		renderPanel();
		const send = await screen.findByRole("button", { name: "chat.send" });
		await waitFor(() => expect(send).toHaveAttribute("aria-disabled", "true"));
		expect(send).not.toBeDisabled();
		expect(send).not.toHaveAttribute("title");
		const tip = await tooltipOn(send);
		expect(tip.text).toBe("chat.composerDisabledNoProvider");
		expect(tip.chip).toBeNull();
	});

	it("shows Enter as a chip on Send once it can send, never inside the string", async () => {
		snapshot.value = {
			config: { provider: "openai", model: "gpt-x" },
			connectedProviders: ["openai"],
			availableProviders: [],
			credentialSummary: [],
		};
		renderPanel();
		fireEvent.change(await screen.findByPlaceholderText("chat.composerPlaceholder"), {
			target: { value: "Cut the silences" },
		});
		const send = screen.getByRole("button", { name: "chat.send" });
		await waitFor(() => expect(send).not.toHaveAttribute("aria-disabled"));
		const tip = await tooltipOn(send);
		expect(tip.text).toBe("chat.sendEnter");
		expect(tip.chip).toBe("Enter");
	});

	// While the title is being edited the button is greyed, but it stays hoverable and does nothing.
	it("keeps Rename tooltip-able while the title is being edited", async () => {
		sessions.list = oneSession;
		renderPanel();
		const rename = await screen.findByRole("button", { name: "chat.renameConversation" });
		fireEvent.click(rename);
		await screen.findByDisplayValue("Conversation 1");
		expect(rename).toHaveAttribute("aria-disabled", "true");
		expect(rename).not.toBeDisabled();
		expect((await tooltipOn(rename)).text).toBe("chat.renameConversation");
	});

	it("keeps Compact tooltip-able while there is no conversation, and does nothing", async () => {
		renderPanel();
		const compact = await screen.findByRole("button", { name: "chat.compactContext" });
		expect(compact).toHaveAttribute("aria-disabled", "true");
		expect(compact).not.toBeDisabled();
		expect((await tooltipOn(compact)).text).toBe("chat.compactContext");
		fireEvent.click(compact);
		expect(chatCompact).not.toHaveBeenCalled();
	});
});
