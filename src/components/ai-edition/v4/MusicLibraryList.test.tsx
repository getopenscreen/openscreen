// @vitest-environment jsdom
// The library has one surface (the inspector's Audio pane) and one list component behind
// it. What this pins is the contract that surface rests on: the catalogue arrives over
// IPC, picking hands the TRACK back rather than placing it, and the licence answer is on
// screen. That last one is not decoration — "do I owe anyone a credit?" is the only
// question a user has about bundled music, and a silent answer is the wrong one.
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { MusicLibraryList } from "./MusicLibraryList";

const TRACKS = [
	{
		id: "sleepy-clouds",
		file: "sleepy-clouds.ogg",
		title: "Sleepy Clouds",
		author: "fupi",
		durationSec: 76.3,
		mood: ["ambient", "calm"],
		license: "CC0-1.0",
		licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
		sourceUrl: "https://opengameart.org/content/sleepy-clouds",
	},
];

const listMusicCatalogue = vi.fn();
const openExternalUrl = vi.fn();

beforeEach(() => {
	listMusicCatalogue.mockResolvedValue({ success: true, tracks: TRACKS });
	openExternalUrl.mockResolvedValue({ success: true });
	Object.defineProperty(window, "electronAPI", {
		configurable: true,
		value: { listMusicCatalogue, openExternalUrl, assetBaseUrl: "file:///app/resources/" },
	});
	// jsdom has no media stack; the list only ever plays its preview element.
	vi.spyOn(window.HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
	vi.spyOn(window.HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
});

afterEach(() => {
	vi.restoreAllMocks();
	listMusicCatalogue.mockReset();
	openExternalUrl.mockReset();
});

function mount(onPick = vi.fn(), active = true) {
	render(
		<I18nProvider>
			<MusicLibraryList active={active} onPick={onPick} />
		</I18nProvider>,
	);
	return { onPick };
}

describe("MusicLibraryList", () => {
	it("lists the bundled catalogue with author, duration and mood", async () => {
		mount();
		expect(await screen.findByText("Sleepy Clouds")).toBeInTheDocument();
		expect(screen.getByText("fupi · 1:16 · ambient, calm")).toBeInTheDocument();
	});

	it("hands the picked track back rather than placing it itself", async () => {
		const { onPick } = mount();
		fireEvent.click(await screen.findByRole("button", { name: /add/i }));
		expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "sleepy-clouds" }));
	});

	it("states that no attribution is owed", async () => {
		mount();
		expect(await screen.findByText(/no attribution/i)).toBeInTheDocument();
	});

	// "More music" is a LINK, not a downloader: nothing is fetched, cached or
	// redistributed by us beyond what already ships. And it is the CC0-FILTERED search
	// the catalogue was sourced from, not a front page — an unfiltered "free music" site
	// mixes licences that forbid redistribution with ones that demand credit in the
	// user's video.
	it("opens the CC0-filtered source externally instead of downloading anything", async () => {
		mount();
		fireEvent.click(await screen.findByRole("button", { name: /more music/i }));
		const [url] = openExternalUrl.mock.calls[0];
		expect(url).toContain("opengameart.org");
		expect(url).toContain("field_art_licenses_tid%5B%5D=4");
	});

	it("says so when the catalogue is empty rather than showing a blank list", async () => {
		listMusicCatalogue.mockResolvedValue({ success: true, tracks: [] });
		mount();
		await waitFor(() => expect(screen.getByText(/no bundled tracks/i)).toBeInTheDocument());
	});

	// The pane is mounted whether or not its facet is showing, so an inactive list must
	// not spend an IPC round trip on a catalogue nobody is looking at.
	it("fetches nothing while inactive", async () => {
		mount(vi.fn(), false);
		await waitFor(() => expect(screen.getByText(/more music/i)).toBeInTheDocument());
		expect(listMusicCatalogue).not.toHaveBeenCalled();
	});
});
