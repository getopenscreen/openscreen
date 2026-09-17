---
id: recording
title: Bildschirmaufnahme
sidebar_position: 4
sidebar_label: Aufnahme
description: "Mit dem HUD von OpenScreen ein Fenster oder den ganzen Bildschirm aufnehmen: Systemaudio, Mikrofon, Webcam, Cursormodi, Countdown, native Aufnahme je Plattform."
keywords:
  - Bildschirm aufnehmen
  - Fenster aufnehmen
  - Systemaudio aufnehmen
  - Webcam aufnehmen
  - ScreenCaptureKit
  - Windows Graphics Capture
  - PipeWire
---

# Bildschirmaufnahme

Aufgenommen wird über das **HUD**, eine verschiebbare, pillenförmige Overlay-Leiste, die immer im Vordergrund bleibt. Sie ignoriert Mausklicks überall außer auf ihren eigenen Bedienelementen und kommt der App, die du aufnimmst, deshalb nie in die Quere.

## Quelle auswählen {#choosing-a-source}

Die Schaltfläche der Quellenauswahl zeigt den aktuell gewählten Bildschirm oder das Fenster (gekürzt) und ist deaktiviert, sobald die Aufnahme läuft. Ein Klick darauf öffnet ein eigenes Fenster mit zwei Tabs:

- **Screens**: eine Karte pro Bildschirm.
- **Windows**: eine Karte pro geöffnetem Fenster, mit dem Symbol der App.

Wähle ein Vorschaubild und klicke auf **Share**. Ist beim Klick auf Aufnahme keine Quelle gewählt, öffnet OpenScreen zuerst die Auswahl und startet die Aufnahme automatisch, sobald du eine Quelle gewählt hast.

Eine Bereichsaufnahme gibt es nicht: Du nimmst einen ganzen Bildschirm oder ein Fenster auf und schneidest das Bild danach im Editor zu, Clip für Clip.

Unter Linux zeigt das HUD keine Quellenauswahl, sondern nur *Your system will ask what to share*. Diese Wahl trifft das ScreenCast-Portal: Ein Klick auf Aufnahme öffnet vor dem Countdown den Freigabedialog deines Desktops, und er fragt bei jedem Take erneut.

## Audio {#audio}

Drei Schalter sitzen in einer gemeinsamen Gruppe:

- **System audio**: nimmt auf, was auf dem Rechner abgespielt wird. Deaktiviert, sobald die Aufnahme läuft.
- **Microphone**: Einschalten (vor der Aufnahme) öffnet ein Popup mit einer Live-Pegelanzeige aus 5 Balken und einer Liste aller verfügbaren Eingabegeräte. So prüfst du, ob das richtige Mikrofon gewählt ist, bevor es losgeht.
- **Webcam**: Einschalten zeigt eine Kameraauswahl mit den erwartbaren Zuständen (Suche läuft, nicht verfügbar, keine Kamera gefunden). Die Webcam wird als eigene Spur aufgenommen und später im Editor ins Bild gesetzt.

Ob Systemaudio unterstützt wird, hängt vom Betriebssystem ab, siehe [Unterschiede zwischen den Plattformen](./installation.md#platform-differences).

## Cursormodus {#cursor-mode}

Unter Windows, macOS und Linux wechselt ein Schalter für den Cursormodus zwischen:
- **Use editable cursor** (Standard): Der Systemcursor bleibt aus dem Bild heraus, und seine Bewegung wird als Daten aufgezeichnet. So kann OpenScreen im Editor einen Cursor zeichnen, dessen Theme, Größe und Animation du festlegst.
- **Use system cursor**: nimmt den Systemcursor unverändert auf, so wie er ist.

Was das bearbeitbare Overlay erfasst, hängt von der Plattform ab:
- **Windows**: die echte Cursorform und Klicks.
- **macOS**: Cursorform und Klicks, wofür die Berechtigung „Bedienungshilfen“ nötig ist. Fehlt sie, öffnet ein Klick auf Aufnahme in diesem Modus einen Hinweis mit einem Link zur Einstellung, statt die Aufnahme zu starten (siehe [Installation unter macOS](./installation.md#macos)).
- **Linux**: Position und Form über das ScreenCast-Portal, dazu Linksklicks, wenn dein Benutzer in der Gruppe `input` ist (siehe [Mausklicks unter Wayland](./installation.md#mouse-clicks-on-wayland)).

Ein Linux-Take, der auf die [Browser-Aufnahme](#native-vs-browser-capture) ausweicht, zeichnet den Systemcursor auf, egal welchen Modus du gewählt hast.

## Aufnahmesteuerung {#recording-controls}

- **Record / Stop**: eine pillenförmige Schaltfläche, die im Ruhezustand beim Überfahren mit der Maus den Namen der Quelle zeigt und während der Aufnahme einen laufenden Timer `mm:ss` (bei pausierter Aufnahme wird der Hintergrund bernsteinfarben).
- **Pause recording** / **Resume recording**: während der Aufnahme verfügbar.
- **Restart recording**: verwirft den aktuellen Take und beginnt neu.
- **Cancel recording**: verwirft den aktuellen Take, ohne zu speichern.
- **Open Studio**: wechselt in den Editor (während der Aufnahme ausgeblendet).

## Countdown {#countdown}

Ein Klick auf Aufnahme startet einen 3‑2‑1-Countdown, der als Overlay über den ganzen Desktop gelegt wird, bevor die Aufnahme tatsächlich beginnt.

## Weitere Bedienelemente im HUD {#other-hud-controls}

- **Use vertical tray** / **Use horizontal tray**: stellt das HUD zwischen waagerecht und senkrecht um und merkt sich die Wahl über Sitzungen hinweg.
- **Device settings**: Geräteeinstellungen für das gewählte Mikrofon und die Kamera, ohne das HUD zu verlassen.
- **Open Notes** (nicht unter Linux): öffnet ein kleines Notizfenster mit Textformatierung, praktisch für ein Skript oder einen Ablaufzettel während der Aufnahme. Der Inhalt wird zwischen Sitzungen lokal gespeichert.
- **Language**: eine Sprachauswahl (13 Sprachen), die nur die Oberfläche von OpenScreen betrifft, nicht deine Aufnahme.
- Fenster-Bedienelemente, um das HUD auszublenden oder die App zu beenden.

## Aus dem Editor aufnehmen (Rec-Modus) {#recording-from-the-editor-rec-mode}

Du musst nicht im HUD anfangen. Stelle im Editor die obere Leiste auf **Rec**, dann bekommst du statt der Leiste eine ganze Seite zur Vorbereitung:

- **Source**: dieselbe Auswahl für Bildschirm oder Fenster, in einem modalen Dialog. Unter Linux steht auch in dieser Zeile *Your system will ask what to share*, und der Portal-Dialog übernimmt die Auswahl.
- **System audio**, **Microphone**, **Camera**: jeweils eine Zeile mit Ein/Aus. Mikrofon und Kamera klappen zu einer Geräteliste auf, und die Kamera zeigt eine Live-Vorschau, damit du dich vor dem Start ins Bild rücken kannst.
- **Cursor highlight**: Eingeschaltet steht für den bearbeitbaren Overlay-Cursor, ausgeschaltet für den einfachen Systemcursor.

**Start recording** öffnet das Aufnahme-Widget und schließt das Editorfenster; ein Abbruch bringt dich zurück in den Modus **Edit**. Hier landest du auch über **New project → Screen recording**.

## Native Aufnahme und Browser-Aufnahme {#native-vs-browser-capture}

Jede Plattform nimmt den Bildschirm über ein natives Hilfsprogramm auf: ScreenCaptureKit unter macOS, Windows Graphics Capture unter Windows 10 ab Build 19041 und PipeWire über das ScreenCast-Portal unter Linux. Die Webcam wird nur unter Windows nativ aufgenommen; macOS und Linux nehmen sie über den Browser auf. Auf allen drei Systemen wird sie als separate Datei gespeichert und im Editor ins Bild gesetzt.

Die Browser-Aufnahme ersetzt das native Hilfsprogramm nur auf Windows-Builds vor 19041 oder wenn einem Windows- oder Linux-Build das Hilfsprogramm fehlt. Schlägt ein natives Hilfsprogramm fehl, gibt es keinen Fallback: Die Aufnahme meldet den Fehler. Siehe die vollständige [Tabelle der Plattformunterschiede](./installation.md#platform-differences).

Wenn die Aufnahme gestoppt ist, geht es unter [Bearbeitung & Zeitleiste](./editing-timeline.md) mit dem Schnitt weiter, oder unter [Mediathek](./media-library.md), wenn du mehrere Takes zusammensetzt.
