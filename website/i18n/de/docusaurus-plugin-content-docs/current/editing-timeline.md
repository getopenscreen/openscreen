---
id: editing-timeline
title: Bearbeitung & Zeitleiste
sidebar_position: 6
description: "Bearbeiten auf der Zeitleiste von OpenScreen: Zoom-, Schnitt- und Tempobereiche, Full-Camera-Segmente, Annotationen, Cursorgestaltung, schwebender Inspektor."
keywords:
  - Video-Zeitleiste
  - Zoombereiche
  - Geschwindigkeitsrampen
  - Annotationen
  - Cursor-Glättung
  - Mehrspur-Bearbeitung
---

# Bearbeitung & Zeitleiste

Der Editor hat drei Modi, die du über den Umschalter in der oberen Leiste wechselst:

| Modus | Wofür |
|---|---|
| **Media** | Die Clips deines Projekts: importieren, suchen, Transkripte ansehen, auf die Zeitleiste ziehen. Siehe [Mediathek](./media-library.md). |
| **Edit** | Die Vorschau, der schwebende Inspektor und die vollständige Zeitleiste. Hier wird das Projekt tatsächlich bearbeitet. |
| **Rec** | Vorbereitung einer neuen Aufnahme: Mikrofon, Kamera, Systemaudio, Cursor. Siehe [Aufnahme](./recording.md#recording-from-the-editor-rec-mode). |

Alles Folgende beschreibt den Modus **Edit**: oben eine Vorschau mit anpassbarer Größe, darunter die Zeitleiste. Zieh den Griff zwischen beiden, um die Aufteilung zu ändern.

## Schwebender Inspektor {#floating-inspector}

Über der Vorschau schwebt eine Symbolleiste mit fünf Tabs:

| Tab | Was er steuert |
|---|---|
| **Composition** | Ein Abschnitt für den Hintergrund (Bild, Volltonfarbe oder Verlauf hinter deiner Aufnahme; eigenes Bild hochladen oder eine Vorlage wählen), dann Hintergrundunschärfe, Schatten, Bewegungsunschärfe, Eckenrundung und Innenabstand. Die Zeile **Format** legt die Ausgabeform für Vorschau und Export fest: die eigenen Formen deiner Clips unter **Original**, dazu 16:9, 9:16, 1:1, 4:3, 4:5, 16:10 und 10:16. |
| **Camera layout** | Webcam-Komposition: Bild-im-Bild, vertikal gestapelt, Doppelrahmen oder keine Webcam. Spiegeln, „Shrink on Zoom“, Kameraform (Rechteck/Kreis/Quadrat/abgerundet) und Größe. Zieh die Webcam-Blase direkt auf der Arbeitsfläche, um sie zu verschieben. |
| **Audio** | Der Ausgabepegel, in Vorschau und Export gleich angewendet. |
| **Cursor** | Nur sinnvoll für Aufnahmen im bearbeitbaren Cursormodus, unter Windows, macOS oder Linux. Ein-/Ausblenden, auf die Arbeitsfläche begrenzen, eine Leiste mit Cursor-Themes und Regler für Größe, Glättung, Bewegungsunschärfe und Klick-Bounce. |
| **Transcript** | Das zusammengeführte Transkript aller Clips, bearbeitbar, siehe [Bearbeitung über das Transkript](./captions.md#transcript-editing). Die Schaltfläche **Captions** darin schaltet Untertitel ein, gestaltet und übersetzt sie, siehe [Untertitel & Transkript](./captions.md#captions). |

Die **Stift**-Schaltfläche in derselben Leiste öffnet den Dialog **Edit clip** für den ausgewählten Clip: ein ziehbares Zuschnittrechteck mit Eingabefeldern für X/Y/W/H und Seitenverhältnis-Vorgaben, dazu Start- und Endpunkt des Clips. Der Zuschnitt gilt pro Clip, nicht pro Projekt.

Wählst du auf der Zeitleiste einen Bereich aus (einen Zoom-, Schnitt-, Annotations-, Geschwindigkeits- oder Full-Camera-Block), ersetzt ein Inspektor für diesen Bereich den Inhalt des Tabs. Er ist unten bei der jeweiligen Bereichsart beschrieben.

## Werkzeugleiste der Zeitleiste {#timeline-toolbar}

- **Auto-enhance** (Zauberstab-Symbol): ein Menü mit zwei einmaligen Durchläufen:
  - **Automatic zooms**: liest die aufgezeichnete Cursorbewegung und setzt Zoombereiche an die Stellen, an denen der Cursor verweilt. Kein Netzwerk, kein Modell. Wie diese Stellen gewählt werden, erklärt [Auto zoom](/features/auto-zoom/).
  - **Smart cuts** (mit *With AI* markiert): übergibt die Aufgabe stattdessen dem KI-Agenten, der einen [verbundenen Anbieter](./ai-editing.md) braucht.
- **Speed** (`S`): fügt am Abspielkopf einen Geschwindigkeitsbereich ein.
- **Comment** (`A`): fügt am Abspielkopf eine Annotation ein.
- **Trim** (`T`): setzt am Abspielkopf einen zwei Sekunden langen Schnitt („Schnittbereich“). Zieh an seinen Rändern, um die Größe zu ändern, wie bei jedem anderen Bereich.
- **Add Zoom** (`Z`): setzt am Abspielkopf einen animierten Zoombereich.
- **Auto-Focus** (Fadenkreuz): ein Schalter. Ist er an, folgt jeder Zoombereich dem Cursor, und die Fokuseinstellung der einzelnen Zooms ist gesperrt.
- **Full Camera** (`C`): fügt ein Segment ein, in dem die Webcam das ganze Bild füllt.

Zieh an den Rändern eines Bereichs, um die Größe zu ändern, oder zieh den Block, um ihn zu verschieben. Bereiche rasten am Abspielkopf, an den Rändern anderer Bereiche sowie an Anfang und Ende der Zeitleiste ein. `Ctrl/Cmd + C` / `Ctrl/Cmd + V` überträgt die Attribute eines ausgewählten Bereichs auf einen anderen Bereich derselben Art.

`Shift` + Scrollen verschiebt die Zeitleiste; `Ctrl`/`Cmd` + Scrollen zoomt hinein und heraus. Beides steht als Hinweis unter der Transportleiste.

### Zoombereiche {#zoom-regions}

Klicke auf einen Zoom-Block, um seinen Inspektor zu öffnen:
- Sechs Zoomstufen: 1.25× / 1.5× / 1.8× / 2.2× / 3.5× / 5×.
- **3D Rotation**: None, Iso, Left oder Right.
- **Focus Mode**: Manual (die Fokusmarke in der Vorschau ziehen) oder Auto (folgt dem aufgezeichneten Cursor). Fest auf Auto, wenn der Schalter Auto-Focus in der Werkzeugleiste an ist.
- **Focus Position**: X/Y als Prozentwerte im manuellen Modus.

Zoombereiche aus **Auto-enhance → Automatic zooms** öffnen denselben Inspektor. Wie dieser Durchlauf arbeitet und wie er im Vergleich zu den automatischen Zooms anderer Rekorder abschneidet, steht unter [Auto zoom](/features/auto-zoom/).

### Schnittbereiche {#trim-regions}

Ein geschnittener Abschnitt fällt aus Wiedergabe und Export heraus. Der Inspektor bietet nur eine Aktion, **Delete**: Drücke `Del` oder nutze die Schaltfläche im Inspektor. Dieselben Schnitte kannst du auch über den Text machen, im [Transkript](./captions.md#transcript-editing).

### Geschwindigkeitsbereiche {#speed-regions}

Eine Auswahlliste mit Vorgaben (0.25× bis 5×, dazu 1× für normale Geschwindigkeit) und ein freies Zahlenfeld, das bis zu 100× annimmt. Der Export gibt in beiden Fällen die tatsächliche Geschwindigkeit wieder.

### Full-Camera-Bereiche {#full-camera-regions}

Ein Abschnitt, in dem die Webcam das Bild füllt, statt in ihrem Layout-Rahmen zu sitzen. Praktisch für ein Intro mit dir vor der Kamera mitten in einer Bildschirmaufnahme. Nur sinnvoll, wenn die Aufnahme eine Webcam-Spur hat.

### Annotationen {#annotations}

Vier Arten, umschaltbar über die Liste **Type** im Inspektor. Beim Umschalten bleiben Zeitspanne und Rahmen des Bereichs erhalten, ein falsch gewählter Typ kostet also einen Klick statt einer neuen Zeichnung.

- **Text**: Inhalt, Größe, Hintergrundfarbe mit Ein/Aus-Schalter, Textfarbe und eine Einblendanimation (None / Fade / Rise / Pop / Slide Left / Typewriter / Pulse).
- **Image**: ein JPG, PNG, GIF oder WebP hochladen.
- **Arrow**: acht Richtungen, Strichstärke (1–20) und Farbe.
- **Blur**: eine Maske für den Datenschutz. Gaussian oder Mosaic, Rechteck oder Oval, mit Stärke (oder Blockgröße beim Mosaik). Zieh und skaliere sie über der Vorschau wie jede andere Annotation.

:::note
Freihand-Unschärfeformen lassen sich nicht mehr zeichnen. Vorhandene werden weiterhin gerendert, aber als ihr umschließendes Rechteck. Das deckt absichtlich zu viel ab, statt etwas, das du als privat markiert hast, im Export sichtbar zu lassen. Der Inspektor weist darauf hin, wenn er eine solche Form findet.
:::

## Cursorgestaltung {#cursor-styling}

Hat deine Aufnahme bearbeitbare Cursordaten (native Aufnahme im bearbeitbaren Cursormodus, unter Windows, macOS oder Linux; unter [Cursormodus](./recording.md#cursor-mode) steht, was jede Plattform aufzeichnet), kannst du im Tab **Cursor** aus einer Sammlung von Cursor-Themes wählen und Größe, Glättung, Bewegungsunschärfe und Klick-Bounce unabhängig von der Rohaufnahme einstellen. Der zugrunde liegende Cursorpfad wird deterministisch geglättet, die Vorschau entspricht also dem finalen Export.

## Tastenkürzel {#keyboard-shortcuts}

Das Zahnradsymbol in der oberen Leiste öffnet den Dialog für Tastenkürzel. Dort lassen sich die konfigurierbaren neu belegen.

| Aktion | Standard |
|---|---|
| Add Zoom | `Z` |
| Add Trim | `T` |
| Add Speed | `S` |
| Add Annotation | `A` |
| Add Full Camera | `C` |
| Add Audio | `M` |
| Record Voiceover | `V` |
| Delete Selected | `Ctrl/Cmd + D` |
| Play / Pause | `Space` |
| Bereichsattribute kopieren | `Ctrl/Cmd + C` |
| Bereichsattribute einfügen | `Ctrl/Cmd + V` |
| Open App (funktioniert aus jeder App) | `Ctrl/Cmd + Shift + O` |

Fest (nicht neu belegbar):

| Aktion | Tastenkürzel |
|---|---|
| Undo | `Ctrl/Cmd + Z` |
| Redo | `Ctrl/Cmd + Shift + Z` (oder `+ Y`) |
| Delete Selected (alt) | `Del` / `⌫` |
| Cycle Annotations Forward / Backward | `Tab` / `Shift + Tab` |
| Frame Back / Forward | `←` / `→` |
| Pan Timeline | `Shift + Scroll` |
| Zoom Timeline | `Ctrl + Scroll` |

## Deine Arbeit speichern {#saving-your-work}

Deine Bearbeitungen liegen in einer `.openscreen`-Projektdatei, getrennt von jedem exportierten Video und vollständig weiter bearbeitbar:

- **Save Project** (`Ctrl/Cmd + S`): speichert in die bestehende Datei oder fragt beim ersten Mal nach einem Speicherort.
- **Load Project** (`Ctrl/Cmd + O`): öffnet eine vorhandene `.openscreen`-Datei.
- **New Project** (`Ctrl/Cmd + N`): leert das aktuelle Projekt.

Die obere Leiste zeigt den Status **Saved** / **Unsaved** an. Wenn du mit ungespeicherten Änderungen schließt, wirst du gefragt, ob du speichern, verwerfen oder abbrechen willst.

Wenn du so weit bist, geht es weiter mit [Export](./export.md).
