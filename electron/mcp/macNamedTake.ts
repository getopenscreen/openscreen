// How the in-app MCP server records the window or display a client names, on a Mac where
// the recording bar picks its sources in Apple's picker (macOS 15.2+).
//
// The picker waits for a person to choose. An MCP client is not one: handing its take to the
// picker left the call waiting 120 s and the picker on screen afterwards (#1232). So a named
// take records its source directly, the way the stdio server and the legacy picker do. That
// needs the Screen Recording grant the picker otherwise makes unnecessary, so a Mac that
// refused it gets an answer saying so instead of a picker.

import type { MacScreenAccessStatus } from "../native-bridge/screen/macScreenAccess";

export const NAMED_TAKE_NEEDS_SCREEN_ACCESS =
	"OpenScreen needs the Screen Recording permission to record a window or display it is told to, without asking which one. Ask the user to turn OpenScreen on under System Settings > Privacy & Security > Screen & System Audio Recording, then try again.";

/**
 * Whether a named take may enumerate its source. Only a refusal the probe actually read
 * stops it: a probe that could not answer (no helper, a crash, a timeout) is not a "no",
 * and the enumeration that follows says for itself whether it can see the source.
 */
export function namedTakeMayEnumerate(screenAccess: MacScreenAccessStatus): boolean {
	return screenAccess !== "denied";
}
