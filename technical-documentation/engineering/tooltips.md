# Tooltip guidelines

How to write and build a hover tooltip or an accessible name in OpenScreen. It covers every window: HUD, Record mode and editor. Terms are fixed in [section 9](#9-terms). The rules are checked against the sources listed at the end.

## 1. The rules

1. **A tooltip is extra.** Anything the user needs to act (a requirement, a warning, an error) is visible, never only in a tooltip. Tooltips do not work on touch, and users do not look for them.
2. **Text on the control means no tooltip,** unless the tooltip adds an effect the label cannot carry. **An icon-only control always has one,** and it names the control.
3. **Never repeat the visible label.** A tooltip that says what the button already says is noise.
4. **Say what happens, not what the control is.** Actions start with an imperative verb ("Add a zoom at the playhead"). Toggles use the third person ("Microphone: records your voice").
5. **A destructive control without a confirmation states the loss** ("Stop and delete this recording").
6. **Toggles follow the pattern in section 3.**
7. **A shortcut is a chip, never text in the string** (section 4).
8. **Use the `Tooltip` primitive** (`src/components/ui/tooltip.tsx`). It opens on hover and on keyboard focus, closes on Escape and as the pointer leaves its trigger, so the next control's tooltip shows at once. Do not build another one. Native `title` is only for revealing truncated text (a file name, a full path) on plain text, or on a status dot whose state is already read out.
9. **Text only.** No link, button, icon or formatting inside. A screen reader flattens formatting and the content cannot take focus.
10. **The trigger is the interactive element.** A tooltip on a `span` or a label is invisible to keyboard and screen reader users. For a switch beside a label, the trigger is the switch.
11. **Inoperative controls are hidden** (section 6).
12. **Keep it short** (section 5). A long explanation belongs in the pane help ("?"), not in a tooltip.

## 2. What each control gets

| Control | Accessible name | Tooltip |
|---|---|---|
| Button, tab or menu item with visible text | The visible text | None |
| Icon-only action button | Short verb phrase | The same string |
| Icon-only toggle | Constant noun, plus `aria-pressed` | "Name: effect", same in both states |
| Toggle with two named modes (editable or system cursor) | Constant noun, plus `aria-pressed` | One string per mode, defining the mode |
| Button whose icon and meaning swap (Play/Pause, Pause/Resume) | The current action | The same string, no `aria-pressed` |
| Switch beside a label | The row label | Only when the label is jargon (Click impact), on the switch |
| Segmented option with visible text | The visible text | None. Icon-only option: its name |
| Swatch, thumbnail, cursor cell | Its name | The same string |
| Truncated text | Not needed | Native `title` with the full text |
| Drag handle, divider | None | None |

## 3. The toggle pattern

* **Name:** a noun that never changes with the state. No "Enable", "Disable" or "Toggle" in it, and no sentence. A name that changes together with `aria-pressed` contradicts itself: a screen reader says "Disable microphone, pressed", which sounds like the opposite of the state.
* **State:** `aria-pressed`. On screen, colour is never the only cue: change the icon (a slash) or its shape as well.
* **Tooltip:** one string, `Name: effect`, the same in both states. Tooltips are read as fixed text and a change of wording between hovers goes unnoticed. Never write "Click to turn off".
* **Exception, two named modes.** When the states are two modes the user has to tell apart, write one string per mode. Each starts with the mode name and defines it. The accessible name stays constant.

| | Before | After |
|---|---|---|
| Accessible name (HUD cursor) | the whole tooltip sentence, 60 characters, different in each state | "Editable cursor", constant, plus `aria-pressed` |
| Tooltip while editable | "Use system cursor: turns off auto zoom and cursor effects" (describes the other state) | "Editable cursor: recorded separately, so you can restyle it and auto-zoom in the editor" |
| Tooltip while system | "Use editable cursor: turns auto zoom and cursor effects back on" | "System cursor: your real cursor, recorded in the video. No restyling, no auto-zoom." |

If the icon has to swap and the wording has to follow (Play, Pause), it is an action button, not a toggle: change the name and the tooltip together and do not set `aria-pressed`.

## 4. Showing a shortcut

* Read the live binding with `formatBinding` or `formatFixedShortcut` and pass it to the `Tooltip` `shortcut` prop. It renders a `<kbd dir="ltr">` chip after the text. One chip, the first binding. No chip when the action has no binding.
* Never write "(Z)" in a string. Seven actions can be remapped, so a baked-in key lies after a remap, sits in 15 locales, and breaks the order of mixed-direction text in Arabic.
* A tooltip is not the only place a shortcut appears. The shortcuts dialog and the menus stay the reference.
* Every control whose action has a binding shows it: Undo, Redo, Play and Pause, the Add buttons, Send.

## 5. Caps

| | Limit |
|---|---|
| English text | 80 characters. 95 for the strings that define the two cursor modes, and for Clear timeline, which has no confirmation and must say what goes and what stays |
| Sentences | 2, one idea each. Punctuation at the end only when there are two |
| Layout | `max-w-[260px]`, `dir="auto"`, balanced lines. 3 lines in English, 4 in French, Italian and Spanish |
| Gap | 8px from the trigger. Where the trigger sits inside a padded surface (a button in the HUD bar), the gap is measured from that surface's edge |
| Case | Sentence case. Form for an icon-only control: `Name: effect` |
| First appearance | 400 ms after the pointer stops, 300 ms to move between neighbours. One value, set on the shared provider |
| Disappearance | Never on a timer. Pointer leaves, focus leaves, or Escape |
| Placement | On the side with room. Never over the next control the user reaches for. In the HUD: above a horizontal bar, beside a vertical one |

## 6. Disabled and inoperative controls

* **Inoperative here: hide it.** Add Full Camera in a project with no camera, the cursor toggle when the app records through the browser and cannot separate the cursor, the Auto-zoom row when the cursor is not editable. No greyed control, no sentence explaining why.
* **Temporarily locked but still informative: keep it.** The HUD toggles during a recording show what is being recorded. Use `aria-disabled="true"` instead of `disabled`, keep it focusable and hoverable, and keep the same tooltip. Dim it. Say nothing more.
* A tooltip on a natively `disabled` button never opens. Do not rely on one.

## 7. Do and don't

| Where | Don't | Do |
|---|---|---|
| Mode tabs | title "Media" on the text "Media" | no tooltip |
| HUD record | "Display 1" (the source name) | "Start recording", then "Stop and save the recording" |
| HUD cancel | "Cancel recording" (deletes it, no confirmation) | "Stop and delete this recording" |
| Timeline | "Add zoom (Z)" | "Add a zoom at the current time" and a chip |
| Timeline | "Auto-Focus on for all zooms, click to switch all to manual", changing with `aria-pressed` | name "Auto-Focus for all zooms", one tooltip |
| Timeline | "Clear timeline" | "Remove all zooms, trims, speeds, annotations and Full Camera. Clips, audio and captions stay." |
| HUD hide | "Hide recording bar" | add how to get it back: "Show it again from the tray icon." |
| Chat | "Compact context" | "Summarize earlier messages to use less context" |
| Segmented rows | every option has a title equal to its text | title only for an icon-only option |

## 8. Writing and translating

* **Literal keys.** Write `t("timeline.buttons.addZoom")`. Not `t(on ? "a" : "b")` and not a key held in a map: `npm run i18n:check` only resolves literal calls, and a missing key shows as raw text.
* **Every key in all 15 locales in the same PR.** Then run `npm run i18n:check`. A tooltip key is not shared with a heading: they change separately.
* **Placeholders** are named (`{{language}}`) and copied unchanged into every locale. Pass a value that may be in another direction (a device name) as its own node or between Unicode isolates.
* **No shortcut and no key name in a string.** The one exception is a modifier passed as `{{modifier}}` (Alt or Option).
* **No idioms, no phrasal verbs, no wordplay.** Use plain verbs: start, stop, remove, show, hide, choose, add. Write "Delete this recording and start a new one", not "Redo it from scratch". One idea per sentence, active voice.
* **No em dash and no middle dot as a connector.** Use a colon or two sentences.
* **One term per concept:** see [section 9](#9-terms). "Camera", not "webcam". "Recording", not "take". Reuse the locale's existing term for a term already translated.
* **Do not build a tooltip from pieces.** One string per tooltip, so word order and punctuation stay right in every language.
* **Length.** French, Italian, Spanish, Portuguese and Russian run up to 55 % longer than English. CJK runs shorter. The caps in section 5 leave room.
* **Machine translation.** Fine for these short strings. Say in the PR that non-English locales were translated by machine, and keep the placeholder and length guard test (`src/i18n/__tests__/tooltipCopy.test.ts`) green. Add each new tooltip key to its list.
* **Tests.** Assert the tooltip through its content and the accessible description, not through `title`. The HUD is click-through, so Playwright cannot hover it: check it by hand with real mouse moves (see [AGENTS.md](../../AGENTS.md) and the [manual checklist](../testing/manual-e2e-checklist.md)).

## 9. Terms

One term per concept, across the HUD, Record mode and the editor. Where a locale already translates a term, reuse its word instead of inventing a synonym.

| Concept | Use | Do not use | Note |
|---|---|---|---|
| Cursor recorded as data, restyled in the editor | **Editable cursor** | Cursor highlight, smart cursor | HUD toggle and the Record mode row. The editor pane and its rail entry stay **Cursor**: the pane only exists when a cursor was recorded. |
| The real OS pointer, drawn into the video pixels | **System cursor** | native cursor, OS cursor, baked-in cursor | Always the counterpart of "editable cursor". Define both in place in the tooltip. |
| The webcam feature | **Camera** | Webcam, cam | HUD, Record mode and editor. "Full Camera" stays a proper name. |
| What the computer plays | **System audio** | computer audio, desktop audio | Gloss it once in the tooltip: "the sound your computer plays". |
| The voice input | **Microphone** | mic | Never abbreviate in English. |
| One recording session and its file | **Recording** | take, clip (a clip is a piece on the timeline), capture | "Take" is a code word (`discardRecordingId`). It does not appear in any UI string. |
| The moving line on the timeline | **playhead** | current time marker, cursor | Never call it "cursor": the cursor is the mouse pointer. In a tooltip write "at the current time", not "at the playhead": in pt-BR, ru and tr the word for playhead is the word for the mouse cursor. |
| The editing window | **Studio** as the name of the HUD button, **the editor** in sentences | "Editor" as a button name | The HUD tooltip defines the name once: "Open Studio: the editor for your recordings". |
| A region on the timeline | zoom, trim, speed change, annotation, Full Camera | segment, block, clip (for a region) | Same words as the region pills ("Zoom 1", "Trim 1"). |
| Toggle position | on / off | enabled / disabled, active | Off is a state, not a verb: never "turn off" or "switch on". |

A new or rewritten string never says "webcam". The same concept keeps the same word in `launch.json`, `editor.json` and `settings.json`: if a term changes in one file, it changes in all three.

## Sources

* Nielsen Norman Group, Tooltip Guidelines: https://www.nngroup.com/articles/tooltip-guidelines/
* W3C, WCAG 2.1 Understanding 1.4.13 Content on Hover or Focus: https://www.w3.org/WAI/WCAG21/Understanding/content-on-hover-or-focus.html
* W3C, WCAG 2.1 Understanding 1.4.1 Use of Color: https://www.w3.org/WAI/WCAG21/Understanding/use-of-color.html
* W3C, WCAG 2.1 Understanding 2.5.3 Label in Name: https://www.w3.org/WAI/WCAG21/Understanding/label-in-name.html
* W3C, WAI-ARIA Authoring Practices, Tooltip pattern: https://www.w3.org/WAI/ARIA/apg/patterns/tooltip/
* W3C, WAI-ARIA Authoring Practices, Button pattern (toggle): https://www.w3.org/WAI/ARIA/apg/patterns/button/
* Sarah Higley, Tooltips in the time of WCAG 2.1: https://sarahmhigley.com/writing/tooltips-in-wcag-21/
* Radix UI, Tooltip: https://www.radix-ui.com/primitives/docs/components/tooltip
* Microsoft, Tooltips and Infotips (Win32 UX guide): https://learn.microsoft.com/en-us/windows/win32/uxguide/ctrl-tooltips-and-infotips
* Microsoft, Fluent 2 Tooltip usage: https://fluent2.microsoft.design/components/web/react/core/tooltip/usage
* Apple, accessibility help text versus label (AppKit controls): https://developer.apple.com/library/mac/documentation/Accessibility/Conceptual/AccessibilityMacOSX/EnhancingtheAccessibilityofStandardAppKitControls.html
* Google, Material plain and rich tooltips (Compose): https://developer.android.com/develop/ui/compose/components/tooltip
* GitHub Primer, Tooltip guidelines: https://primer.style/product/components/tooltip/guidelines/
* Atlassian Design, Tooltip usage: https://atlassian.design/components/tooltip/usage/
* Smart Interface Design Patterns, Disabled buttons: https://smart-interface-design-patterns.com/articles/disabled-buttons/
