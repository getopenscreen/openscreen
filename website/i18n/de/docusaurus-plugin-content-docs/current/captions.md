---
id: captions
title: Untertitel & Transkript
sidebar_position: 7
description: "Mit Whisper lokal in 100 Sprachen transkribieren, gestaltete Untertitel einbrennen, mit eigenem LLM-Schlüssel übersetzen, durch Löschen von Wörtern schneiden."
keywords:
  - automatische Untertitel
  - Untertitel
  - Whisper-Transkription
  - Offline-Transkription
  - Untertitel übersetzen
  - Transkript bearbeiten
---

# Untertitel & Transkript

OpenScreen transkribiert den Ton deiner Aufnahme **vollständig lokal auf deinem Gerät**: Dein Audio wird nie hochgeladen, und sobald das Modell auf der Festplatte liegt, funktioniert die Transkription offline. Dieses eine Transkript ist dann die Grundlage für zwei Dinge: die Untertitel, die in dein Video eingebrannt werden, und eine Textansicht, über die du deine Aufnahme bearbeiten kannst.

## Transkribieren {#transcribing}

Jeder Clip hat sein eigenes Transkript. Du startest es auf einem von zwei Wegen:

- Über die Arbeitsfläche **Media**: Wähle eine Asset-Karte aus und klicke auf **Regenerate**. Hier legst du unter **Regenerate as** auch eine der 100 Sprachen von Whisper fest, statt die automatische Erkennung (**Auto**) beizubehalten, und hier steht der Status jedes Assets (Pending transcription, Transcribing, Transcript ready, Transcription failed und die anderen, die unter [Mediathek](./media-library.md#media-mode) aufgeführt sind).
- Über den Tab **Transcript** im Inspektor des Editors: **Transcribe now** führt dieselbe Pipeline für das aktuelle Medium aus.

Die Engine whisper.cpp ist in der App enthalten, das Modell nicht. Der erste Durchlauf lädt es von huggingface.co herunter (ca. 264 MB, per SHA-256 geprüft und atomar geschrieben, sodass ein halber Download nie verwendet werden kann). Das ist der einzige Moment, in dem die Transkription eine Netzwerkverbindung braucht. Danach läuft sie komplett offline, auf einem Backend, das zur Laufzeit gewählt wird: Metal auf Apple Silicon; Vulkan unter Windows und Linux, mit CPU als Fallback; CPU auf Intel-Macs.

Die Zeitmarken der Wörter stammen aus Whispers eigenen DTW-Token-Zeitstempeln und werden dann am Audio selbst neu verankert: Jede Grenze wird auf den leisesten Moment direkt davor zurückgezogen. Deshalb landet ein über das Transkript gesetzter Schnitt dort, wo das Wort tatsächlich beginnt, und nicht eine Silbe zu spät.

## Untertitel {#captions}

Untertitel sind eine **Live-Ansicht des Transkripts**, kein erzeugter Text, den du danach pflegen musst. Änderst du das Transkript oder die Untertiteleinstellungen oder verschiebst du Clips auf der Zeitleiste, ziehen die Untertitel im nächsten Frame nach. Es gibt keinen Schritt zum Neuerzeugen und keine veraltete Kopie, die abgeglichen werden müsste.

Klicke im Tab **Transcript** des Inspektors auf **Captions**:

| Abschnitt | Einstellungen |
|---|---|
| **Show captions** | Hauptschalter für Vorschau und Export. |
| **Language** | *Original (transcript)* oder eine der Übersetzungsebenen, die du erzeugt hast. |
| **Text** | Schrift, Größe, Fett, Textfarbe. |
| **Background** | Ein/Aus, Farbe und Deckkraft der Fläche hinter dem Text. |
| **Position** | **Bottom** oder **Top**, mit dem Abstand von diesem Rand (0–50 % des Bildes); **Left**, **Center** oder **Right**, mit dem Abstand von dieser Seite (0–25 %, keiner bei Center). |
| **Line length** | Mindest- und Höchstzahl an Wörtern pro Zeile (1–12). Die Zeilen werden innerhalb dieses Bereichs gefüllt. |

Alles unter **Position** wird am **exportierten Bild** gemessen, nicht am Video darin. Untertitel bleiben an ihrem Platz, wenn du den Innenabstand änderst, und sie können im Randbereich sitzen: Setzt du den vertikalen Abstand auf 0, liegt der Text bündig am oberen oder unteren Bildrand. Lange Untertitel wachsen von dem Rand weg, an dem sie verankert sind: Ein Untertitel unten wächst nach oben, einer oben nach unten.

Die Größe wird in Pixeln bei einem 1080 Pixel hohen Bild angegeben und skaliert mit der tatsächlichen Ausgabe, sodass Untertitel bei 720p, 1080p oder Quellauflösung gleich aussehen. Vorschau und Export nutzen denselben Layout-Code: Was du siehst, wird eingebrannt. Eingebrannt ist die einzige Form: OpenScreen schreibt keine separate `.srt`- oder `.vtt`-Datei, deshalb kann niemand, der das Video ansieht, die Untertitel ausschalten. [Lokale Untertitel im Vergleich](/features/captions/) nennt Rekorder, die eine Untertiteldatei schreiben.

### Übersetzung {#translation}

Wähle eine Zielsprache und klicke auf **Translate**. Die Liste enthält fünfzehn Zielsprachen: Englisch, Französisch, Spanisch, Deutsch, Italienisch, Portugiesisch, Niederländisch, Polnisch, Türkisch, Russisch, Arabisch, Hindi, Japanisch, Koreanisch und Chinesisch.

Die Übersetzung läuft über den LLM-Anbieter, den du verbunden hast (siehe [KI-Bearbeitung](./ai-editing.md)). Sie ist die einzige Untertitelfunktion, die eine Netzwerkverbindung braucht. Gespeichert wird sie **neben** dem Transkript, nie darin: Originaltext und Zeitmarken bleiben unverändert, du kannst jederzeit zurück zu *Original* wechseln, und das Löschen einer Übersetzung lässt die Aufnahme genau so, wie sie war. Übersetzt du nach dem Hinzufügen von Material erneut, kostet das nur das neue Material, und alles, was das Modell nicht zurückgibt, fällt auf die Originalwörter zurück, statt erfunden zu werden.

:::note
Projekte, die mit dem älteren Ablauf „generate captions“ erstellt wurden, enthalten den Untertiteltext als echte Annotationen, die über der Live-Ebene gezeichnet würden. Der Bereich **Captions** erkennt sie und bietet an, sie zu entfernen. Er fragt vorher nach, weil dabei Daten gelöscht werden.
:::

## Bearbeitung über das Transkript {#transcript-editing}

Der Tab **Transcript** zeigt das zusammengeführte Transkript aller Clips auf der Zeitleiste. Er ist eine Live-Textansicht deiner Aufnahme:

- Wähle ein Wort oder mehrere Wörter aus und drücke `Backspace`/`Delete`, um diesen Abschnitt als übersprungen zu markieren. Er fällt aus Wiedergabe und Export heraus, genau wie ein Schnittbereich auf der Zeitleiste, nur eben über den Text gesteuert.
- Übersprungene Abschnitte erscheinen rot durchgestrichen. Fahr mit der Maus über einen davon, um ihn wiederherzustellen.
- Pausen werden direkt im Text markiert und lassen sich genauso schneiden oder wiederherstellen.

Kein Upload, keine Cloud: Das alles arbeitet mit dem Transkript, das schon in deinem Projekt liegt.
