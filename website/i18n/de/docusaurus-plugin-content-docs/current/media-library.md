---
id: media-library
title: Mediathek & Clips
sidebar_position: 5
description: "Quellen und Clips in OpenScreen verwalten: Videos importieren, Clips auf einer Zeitleiste kürzen, zuschneiden, teilen und umsortieren, Ausgabegröße festlegen."
keywords:
  - Mediathek
  - Videoclips
  - Video kürzen
  - Video zuschneiden
  - Clips teilen
  - Zeitleiste
---

# Mediathek & Clips

Ein Projekt ist nicht eine einzelne Aufnahme, sondern eine Sammlung von Quellen und eine geordnete Liste von Clips, die aus ihnen geschnitten sind. Im Modus **Media** verwaltest du die Quellen; in der Clipzeile unten auf der Zeitleiste ordnest du sie an.

## Media-Modus {#media-mode}

Stelle die obere Leiste auf **Media**. Die Arbeitsfläche zeigt eine Karte pro Quelle im Projekt, darüber ein Suchfeld.

Wähle eine Karte aus, um ihre Detailansicht zu öffnen:

- **Source Transcript**: der vollständige Text dieses Assets mit seinem Status (No transcript / Pending transcription / Downloading speech model / Starting speech model / Transcribing / Transcript ready / No speech detected / No audio track / Transcription failed) und der erkannten Sprache.
- **Regenerate as**: führt Whisper lokal erneut für dieses Asset aus, entweder mit automatischer Erkennung (**Auto**) oder fest auf eine der 100 Sprachen, die Whisper unterstützt.

**Import media** fügt ein Video von der Festplatte hinzu. Der Dateidialog akzeptiert `webm`, `mp4`, `mov`, `avi`, `mkv`, `m4v`, `wmv`, `flv` und `ts`. Diese Arbeitsfläche nimmt nur Videos auf: Musik und andere Audiodateien kommen über das Menü **Add audio** in der Werkzeugleiste der Zeitleiste dazu, Bilder als [Bildannotationen](./editing-timeline.md#annotations).

Eine importierte Quelle landet *nicht* automatisch auf der Zeitleiste. Dafür ziehst du ihre Karte in die Clipzeile.

## Clips auf der Zeitleiste {#clips-on-the-timeline}

Die unterste Zeile der Zeitleiste ist die Clipleiste. Jeder Clip zeigt seine eigene Wellenform.

- **Zum Umsortieren ziehen.** Die Bereiche darüber folgen ihrem Clip: Ein Zoom, den du auf einen Clip gelegt hast, bleibt auf diesem Clip, wenn der Clip verschoben wird.
- **Doppelklick** (oder der Stift auf einem Clip) öffnet **Edit clip**: Start- und Endpunkt mit einem Bereich, den du mit der Maus durchspulen kannst, und ein Zuschnittrechteck mit ziehbaren Anfassern, numerischen Werten X/Y/W/H und Seitenverhältnis-Vorgaben. Der Zuschnitt gilt pro Clip.
- **Delete clip** entfernt ihn von der Zeitleiste; die Quelle bleibt in der Mediathek.
- **Zieh eine Quelle auf einen vorhandenen Clip**, und OpenScreen fragt, wohin sie soll: **Add before**, **Add after** oder **Split here and insert**. Letzteres teilt den Zielclip an der Ablegestelle und setzt die neue Quelle dazwischen.

Clips schließen immer direkt aneinander an: keine Lücken, keine Überlappungen. Wenn du einen entfernst oder verschiebst, rückt der Rest auf dem Zeitlineal nach.

## Ausgabegröße {#output-size}

Die Einstellung **Format** im Tab **Composition** legt die Form des Bildes fest; unter **Original** stehen die tatsächlichen Formen der Clips in deinem Projekt. Jeder Clip wird in dieses Bild eingepasst. Eine Bildschirmaufnahme in 16:9 und eine Handyaufnahme in 9:16 lassen sich deshalb auf einer Zeitleiste mischen. Welche Auflösung dabei herauskommt, steht unter [Export](./export.md#resolution).

## Ein Projekt beginnen {#starting-a-project}

**New project** fragt nach einem Namen und einem Ausgangspunkt:

- **Screen recording**: springt direkt in den [Rec-Modus](./recording.md#recording-from-the-editor-rec-mode).
- **Import media**: öffnet die Dateiauswahl.

**Open project** listet deine zuletzt verwendeten `.openscreen`-Dateien mit Suchfeld, Tastaturnavigation und der Ausweichmöglichkeit **Browse files…**. Du kannst eine `.openscreen`-Datei auch auf den leeren Editor ziehen.
