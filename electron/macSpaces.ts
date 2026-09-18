// Making a window follow the user across macOS Spaces without demoting the whole app.
//
// `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })` does more than its name
// says. Unless `skipTransformProcessType` is passed, Electron's darwin implementation calls
// `app.dock.hide()` on the way through, which switches the process to the *accessory*
// activation policy (lsappinfo reports `ApplicationType = UIElement`). An accessory app has
// no Dock icon, is missing from Cmd+Tab, and never owns the menu bar, so the application
// menu, including "Save Diagnostics", vanished even while the editor had focus (reported on
// 1.11.0, macOS 26.6.2, while chasing #709).
//
// `main.ts` calls `app.dock.show()` on ready specifically to be a regular app, but the HUD
// is created after that and made the call above, so the policy was reversed the moment the
// first window opened. The source selector and the countdown overlay did the same.
//
// The cost of skipping the transform: an app that stays regular cannot float its windows
// over ANOTHER app's full-screen Space (AppKit reserves that for accessory apps since
// 10.14). The HUD still follows across ordinary Spaces, which is what these calls were
// added for (e7d82e147). The HUD is excluded from capture anyway, and a take can still be
// stopped from the tray.

/** The slice of `BrowserWindow` this needs, so the rule can be tested without Electron. */
export type SpacesFollowingWindow = {
	setVisibleOnAllWorkspaces(
		visible: boolean,
		options?: { visibleOnFullScreen?: boolean; skipTransformProcessType?: boolean },
	): void;
};

export function followAcrossSpaces(
	win: SpacesFollowingWindow,
	platform: NodeJS.Platform = process.platform,
): void {
	if (platform !== "darwin") {
		return;
	}
	win.setVisibleOnAllWorkspaces(true, {
		visibleOnFullScreen: true,
		skipTransformProcessType: true,
	});
}
