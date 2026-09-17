---
id: product-demo-video
title: So erstellst du ein Produktdemo-Video
sidebar_label: Produktdemo-Video
description: "So erstellst du ein Produktdemo-Video mit OpenScreen: Skript, Aufnahme mit 60 fps, dann Webcam, automatische Zooms, Schnitte, Unschärfe, Untertitel und Export."
keywords:
  - Produktdemo-Video
  - Software-Demo aufnehmen
  - Demo-Video mit Zoom und Untertiteln
  - Bildschirmaufnahme Anleitung
  - Teleprompter
---

# So erstellst du ein Produktdemo-Video

Für ein Produktdemo-Video schreibst du ein kurzes Skript, nimmst das Produkt in ruhigem Tempo auf und bearbeitest dann: Leerlauf herausschneiden, auf das Wichtige zoomen, private Daten verbergen, Untertitel hinzufügen und im Format exportieren, das dein Kanal braucht. Diese Anleitung geht jeden Schritt in OpenScreen durch, einem kostenlosen Bildschirmrekorder und Editor unter MIT-Lizenz für Windows, macOS und Linux, bei dem Aufnahme, Bearbeitung, Transkription und Export auf deinem Rechner laufen. OpenScreen erzeugt eine Videodatei. Es hostet das Video nicht und baut keine klickbare Tour; wenn du eines davon brauchst, lies [Wann OpenScreen nicht das richtige Werkzeug ist](#when-openscreen-is-not-the-right-tool).

## Bevor du anfängst {#before-you-start}

- Installiere OpenScreen über die [Download-Seite](/download/). [Installation](../installation.md) beschreibt jede Plattform.
- Überleg dir, wo das Video angesehen wird. Davon hängt das Format ab: 16:9 für eine Website oder Doku-Seite, 9:16 für einen vertikalen Feed, 1:1 für einen quadratischen Platz.
- Bereite das Produkt vor: ein Demo-Konto, Beispieldaten, Benachrichtigungen aus.

## 1. Das Skript im Notizfenster schreiben {#1-write-the-script-in-the-notes-window}

Unter Windows und macOS klickst du im HUD auf **Open Notes**. Das öffnet ein Fenster mit Textformatierung, dessen Inhalt zwischen Sitzungen lokal gespeichert wird. Schreib dort das Skript, eine Aktion pro Zeile. Das Linux-HUD hat keine Notes-Schaltfläche.

Das Notizfenster dient auch als Teleprompter. **Start auto-scroll** scrollt den Text mit einer Geschwindigkeit von 10 bis 100. Die Schriftgröße reicht von 14 bis 48 px, und **Mirror horizontally** spiegelt den Text.

:::caution
Unter Windows hält OpenScreen das HUD und das Notizfenster aus der Aufnahme heraus. Unter macOS kann es das nicht garantieren, lass das Notizfenster dort also auf einem Bildschirm, den du nicht aufnimmst. Unter macOS und Linux nutzt du **Hide HUD**, wenn das HUD auf dem aufgenommenen Bildschirm liegt.
:::

## 2. Den Bildschirm oder ein Fenster aufnehmen {#2-record-the-screen-or-a-window}

1. Unter Windows und macOS öffnest du die Quellenauswahl und wählst unter **Screens** einen Bildschirm oder unter **Windows** ein einzelnes Fenster. Unter Linux gibt es keine Auswahl in der App: Das Systemportal fragt bei jedem Take nach der Quelle. OpenScreen hat keine Bereichsaufnahme. Nimm also das Fenster oder den Bildschirm auf und schneide den Clip dann im Editor zu.
2. Schalte das Mikrofon ein und prüfe seine Pegelanzeige. Schalte Systemaudio ein, wenn das Produkt Töne macht, und die Webcam, wenn du im Bild sein willst.
3. Behalte den bearbeitbaren Cursormodus, den Standard: Der Zeiger wird als Daten aufgezeichnet, du kannst ihn also später neu gestalten. Klicks werden unter Windows aufgezeichnet. Unter macOS brauchen sie die Berechtigung „Bedienungshilfen“. Unter Linux muss dein Benutzer in der Gruppe `input` sein, und Tippen zum Klicken auf dem Touchpad wird nicht erfasst ([Details](../installation.md#mouse-clicks-on-wayland)).
4. Starte die Aufnahme. Vorher läuft ein 3-2-1-Countdown, der sich nicht abschalten lässt.

OpenScreen nimmt mit angestrebten 60 fps auf, unter Windows und macOS bis 3840×2160. Unter Linux entspricht die Größe dem, was der Compositor liefert. Während der Aufnahme kannst du pausieren, den Take neu starten, ihn abbrechen oder stoppen.

**Tempo für die Zooms.** Bewege den Zeiger zu dem, was du gleich erklärst, und halte ihn dann still. Die automatischen Zooms aus Schritt 4 suchen nach diesen Pausen: ein ruhender Zeiger für etwa eine halbe Sekunde bis 2,6 Sekunden. Ein Zeiger, der länger ruht, bekommt keinen Zoom.

**Lange Demos unter Linux.** Linux schreibt ein normales MP4, das erst beim Stoppen abgeschlossen wird. Ein Absturz mitten im Take hinterlässt also eine unlesbare Datei. Nimm stattdessen mehrere kürzere Takes auf; Schritt 5 zeigt, wie du sie zusammenfügst.

Alle Bedienelemente des HUD stehen unter [Aufnahme](../recording.md).

## 3. Webcam-Layout und Hintergrund wählen {#3-choose-the-webcam-layout-and-background}

Die Webcam wird in eine eigene Datei aufgenommen. Ihre Platzierung ist also eine Entscheidung beim Schnitt, die du jederzeit ändern kannst. Öffne im Inspektor des Editors den Tab **Camera layout**:

- **Picture in Picture**, **Vertical Stack**, **Dual Frame** oder **No Webcam**.
- Für jedes Layout: Spiegeln und ein Zuschnitt des Kamerabilds.
- Nur für **Picture in Picture**: **Camera Shape** (Rect, Circle, Square oder Rounded), eine Größe von 10 bis 50 % (standardmäßig 25 %) und **Shrink on Zoom**, standardmäßig an: Es verkleinert die Kamera, während ein Zoom läuft, damit sie das Detail nicht verdeckt. Zieh die Kamera auf der Arbeitsfläche, um sie zu verschieben.
- **Camera Background**: Original, Blur, Cutout oder Custom. Cutout entfernt den Hintergrund ohne Greenscreen, mit einem Segmentierungsmodell, das auf deiner CPU läuft. Dieser Abschnitt erscheint nur, wenn sich die Segmentierungs-Laufzeit auf deinem Rechner laden lässt.

Für ein Intro oder Outro drückst du `C`, um ein **Full Camera**-Segment hinzuzufügen: Die Kamera füllt in diesem Abschnitt das ganze Bild.

Der Tab **Composition** gestaltet das Bild. Sein Hintergrundabschnitt bietet 18 mitgelieferte Hintergrundbilder, eine Volltonfarbe, einen Verlauf oder dein eigenes Bild sowie eine Hintergrundunschärfe. Darunter folgen Schatten, Rundung, Innenabstand und Bewegungsunschärfe.

## 4. Automatische Zooms hinzufügen {#4-add-automatic-zooms}

Öffne in der Werkzeugleiste der Zeitleiste **Auto-enhance** und wähle **Automatic zooms**. OpenScreen liest die aufgezeichnete Cursorbewegung und setzt Zoombereiche auf diese Pausen, ohne Netzwerk und ohne Modell. Setzt der Durchlauf nichts, sagt OpenScreen dir das. Die üblichen Ursachen sind eine Aufnahme ohne Cursordaten, keine Pause in diesem Abschnitt oder vorhandene Zooms, die diese Momente schon abdecken.

Prüfe die Zooms anschließend. Klicke auf einen Zoom, um seine Stufe (von 1.25× bis 5×), seinen Fokusmodus (Auto folgt dem Cursor, Manual hält einen festen Punkt) und eine optionale 3D-Drehung einzustellen. Mit `Z` fügst du einen Zoom von Hand hinzu, mit `Ctrl/Cmd+D` löschst du einen, den du nicht willst.

Mehr dazu, wie die Zooms gesetzt werden: [Auto-zoom](/features/auto-zoom/).

## 5. Über das Transkript schneiden und Leerlauf beschleunigen {#5-cut-from-the-transcript-and-speed-up-dead-time}

**Zuerst transkribieren.** Öffne den Tab **Transcript**. Gibt es dort noch kein Transkript, klicke auf **Transcribe now**. Die Transkription läuft lokal mit Whisper. Der erste Durchlauf lädt das Modell einmalig herunter, etwa 264 MB.

**Über den Text schneiden.** Markiere im Transkript Wörter und drücke `Delete`: Dieser Abschnitt fällt aus Wiedergabe und Export heraus. Pausen erscheinen als Markierungen im Text: Klicke auf eine, um sie zu schneiden, und noch einmal, um sie wiederherzustellen. Fahr mit der Maus über ein geschnittenes Wort, um es wiederherzustellen. Du kannst auch `T` drücken, um auf der Zeitleiste einen Schnittbereich hinzuzufügen.

**Beschleunige, was du nicht schneiden kannst**, etwa Ladezeiten oder Tipparbeit. Drücke `S`, um einen Geschwindigkeitsbereich hinzuzufügen, wähle eine Vorgabe von 0.25× bis 5× oder gib einen beliebigen Wert von 0.1× bis 100× ein. Der Ton wird passend zeitgestreckt.

**Mehrere Takes zusammenfügen.** Wechsle zu **Media**, nutze **Import media**, falls ein Take noch nicht aufgeführt ist, und zieh seine Karte dann in die Clipzeile. Legst du die Karte auf einem vorhandenen Clip ab, bietet OpenScreen **Add before**, **Add after** oder **Split here and insert** an. Siehe [Mediathek](../media-library.md).

Wenn du deinen eigenen LLM-Anbieter verbunden hast, übergibt **Auto-enhance → Smart cuts** das Schneiden dem KI-Agenten. Das ist optional und bleibt aus, bis du einen Schlüssel hinzufügst ([KI-Bearbeitung](../ai-editing.md)). Rückgängig machen reicht 50 Schritte zurück, Änderungen des Agenten eingeschlossen.

## 6. Private Daten unkenntlich machen, annotieren, Ton hinzufügen {#6-blur-private-data-annotate-add-sound}

Drücke `A`, um eine Annotation hinzuzufügen, und wähle dann ihren **Type**:

- **Blur**: Gaussian oder Mosaic, Rechteck oder Oval. Leg sie über E-Mail-Adressen, API-Schlüssel oder Kundennamen, dehne ihren Bereich über alle Frames aus, in denen sie zu sehen sind, und spule dann zur Kontrolle durch.
- **Text**: mit optionaler Animation (Fade, Rise, Pop, Slide Left, Typewriter oder Pulse).
- **Arrow**: acht Richtungen, einstellbare Strichstärke und Farbe.
- **Image**: ein JPG, PNG, GIF oder WebP, etwa ein Logo.

Für Ton drückst du `V`, um auf der Zeitleiste ein Voice-over aufzunehmen, oder `M`, um Musik zu importieren (mp3, wav, m4a, aac, flac, ogg, opus). Jede Spur hat eigene Einstellungen für Pegel, Ein- und Ausblenden, Schleife und Stummschaltung.

Der Tab **Cursor** gestaltet den Zeiger aus Schritt 2 neu. Alle Werkzeuge stehen unter [Bearbeitung & Zeitleiste](../editing-timeline.md).

## 7. Untertitel einbrennen {#7-burn-in-captions}

Klicke im Tab **Transcript** auf **Captions** und schalte **Show captions** ein. Die Untertitel werden live aus dem Transkript gezeichnet, die Schnitte aus Schritt 5 gelten also ohne zusätzlichen Schritt auch für sie. Stelle Schrift, Größe, Fett, Farbe, Hintergrundfläche, Position und 1 bis 12 Wörter pro Zeile ein. Prüfe die Platzierung in der Vorschau nach jeder Änderung des Formats.

Whisper erkennt die gesprochene Sprache, oder du legst mit **Regenerate as** auf der Arbeitsfläche **Media** eine der 100 Sprachen fest. Um in einer anderen Sprache zu veröffentlichen, nutzt du **Translate** für eine von 15 Zielsprachen und wählst diese Sprache vor dem Export unter **Display** aus. Die Übersetzung läuft über deinen eigenen LLM-Anbieter und braucht deshalb einen Schlüssel.

Untertitel werden ins Video eingebrannt. OpenScreen schreibt keine `.srt`- oder `.vtt`-Datei, ein Player kann sie also nicht ausschalten. Details: [Untertitel & Transkript](../captions.md) und [wie die Untertitelfunktion arbeitet](/features/captions/).

## 8. Exportieren {#8-export}

**Format wählen.** Die Einstellung **Format** im Tab **Composition** bietet 16:9 (Standard), 9:16, 1:1, 4:3, 4:5, 16:10, 10:16 oder die ursprüngliche Form deiner Clips.

**Exportieren.** Klicke in der oberen Leiste auf **Export**:

- **MP4**: 720p, 1080p oder Source; 24, 30 oder 60 fps; H.264 oder H.265. Der Dialog kennzeichnet H.264 als die Option mit der besten Kompatibilität. Die Videobitrate lässt sich nicht einstellen und liegt bei 1080p bei etwa 8 Mbit/s.
- **GIF**: 15, 20, 25 oder 30 fps; Größe Medium, Large oder Original; Schleife an oder aus. GIFs nutzen 256 Farben ohne Dithering und eignen sich deshalb für kurze Clips von Oberflächen im Flat Design.

Es gibt kein Wasserzeichen. Für ein anderes Format änderst du die Einstellung und exportierst erneut.

**Das Projekt behalten.** Speichere es mit `Ctrl/Cmd+S` als `.openscreen`-Datei, damit du einen Clip austauschen und erneut exportieren kannst, wenn sich die Oberfläche ändert. Die Datei verweist auf deine Medien, statt sie einzubetten; `openscreen pack` sammelt alles in einem portablen Ordner ([CLI](/docs/cli/)). Mehr unter [Export](../export.md).

## Die Datei veröffentlichen {#publish-the-file}

OpenScreen hostet dein Video nicht, erstellt keine Freigabelinks und zählt keine Aufrufe. Lade die exportierte Datei dort hoch, wo dein Publikum sie ansieht.

## Wann OpenScreen nicht das richtige Werkzeug ist {#when-openscreen-is-not-the-right-tool}

- **Du willst einen gehosteten Link mit Zuschauerstatistiken oder Kommentaren.** Dafür passt ein Rekorder mit Hosting besser. Loom zum Beispiel teilt jede Aufnahme als Link auf loom.com, und seine Preisseite nennt Zuschauer-Insights und Videokommentare in jedem Tarif (Stand September 2026). Unter [OpenScreen als Loom-Alternative](/alternatives/loom/) steht der engere Fall, in dem OpenScreen doch passt.
- **Du willst eine interaktive Demo**, durch die sich die Zuschauer klicken. OpenScreen exportiert nur Video und GIF.
- **Dein Videoplayer braucht eine separate Untertiteldatei.** OpenScreen brennt Untertitel nur ein.
- **Du nimmst auf einem Smartphone oder Tablet auf.** OpenScreen ist eine Desktop-App für Windows, macOS ab Version 13 und Linux.

## Quellen {#sources}

- OpenScreen: der [Quellcode zum Release v1.11.0](https://github.com/getopenscreen/openscreen/tree/v1.11.0).
- Loom: [loom.com](https://www.loom.com) und [loom.com/pricing](https://www.loom.com/pricing), geprüft im September 2026.

Loom ist eine Marke ihres Inhabers. OpenScreen steht in keiner Verbindung zu Loom.
