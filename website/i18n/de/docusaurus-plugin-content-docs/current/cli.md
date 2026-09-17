---
id: cli
title: Bildschirmrekorder-CLI für Skripte und Agenten
sidebar_label: CLI
description: "OpenScreens Bildschirmrekorder-CLI nimmt auf, untertitelt und exportiert .openscreen-Projekte aus Skripten, CI-Jobs und Coding-Agenten, mit NDJSON-Ausgabe."
keywords:
  - Bildschirmrekorder CLI
  - Bildschirm per Kommandozeile aufnehmen
  - Headless-Bildschirmrekorder
  - Produktdemo-Video automatisieren
  - NDJSON
  - openscreen export
---

# Bildschirmrekorder-CLI

Die Kommandozeilenschnittstelle von OpenScreen ist in die ausführbare Datei der Desktop-App selbst eingebaut. `openscreen record`, `captions`, `export`, `pack`, `info` und `sources` laufen im Terminal, ohne ein Fenster zu öffnen, und `--json` macht aus ihrer Ausgabe NDJSON auf stdout. Ein Skript, ein CI-Job oder ein Coding-Agent kann einen Take aufnehmen, das `.openscreen`-Projekt als einfaches JSON bearbeiten und mit demselben nativen Compositor wie die Schaltfläche **Export** im Editor ein MP4 oder GIF rendern.

Ein Server-Tool ist sie nicht. Jeder Befehl startet Electron, das einen Displayserver braucht, auch wenn kein Fenster erscheint, und für die Aufnahme ist eine echte Desktop-Sitzung nötig. Siehe [Wann die CLI nicht das richtige Werkzeug ist](#when-the-cli-is-not-the-right-tool).

:::caution
Die CLI und das Projektformat `.openscreen` können sich zwischen Versionen noch inkompatibel ändern. Prüfe deine Skripte nach jedem Update.
:::

## Die CLI ausführen {#running-the-cli}

[Installiere OpenScreen](/download/) zuerst ([Installation](./installation.md)). Jeder Befehl ist ein Unterbefehl der ausführbaren Datei der App:

| Installation | Ausführbare Datei |
|---|---|
| macOS | `/Applications/Openscreen.app/Contents/MacOS/Openscreen` |
| Windows-Installer | `Openscreen.exe` im Ordner, der bei der Einrichtung gewählt wurde: `%LOCALAPPDATA%\Programs\Openscreen\` bei einer Installation für den aktuellen Benutzer, `C:\Program Files\Openscreen\` für alle Benutzer |
| Linux `.deb`, `.rpm`, `.pacman` | `openscreen` |
| Linux-AppImage | `./Openscreen-Linux-1.11.0.AppImage` |
| Nix | `openscreen` |

Die Beispiele auf dieser Seite verwenden `openscreen`. Unter macOS und Windows nimmst du den vollständigen Pfad oder einen Alias:

```bash
/Applications/Openscreen.app/Contents/MacOS/Openscreen export demo.openscreen -o demo.mp4
```

- `openscreen help`, `--help` oder `-h` gibt den Hilfetext aus.
- Chromium-Schalter vor dem Unterbefehl werden übersprungen. Wenn die Sandbox von Chromium auf dem Host nicht starten kann, führe `./Openscreen-Linux-1.11.0.AppImage --no-sandbox export demo.openscreen` aus.
- CLI-Läufe belegen nicht die Einzelinstanz-Sperre der App, sie funktionieren also auch, während die Desktop-App geöffnet ist.
- Aus einem Checkout des Quellcodes baust du die App und ihre nativen Hilfsprogramme wie unter [Build and packaging (auf Englisch)](https://github.com/getopenscreen/openscreen/blob/main/technical-documentation/engineering/build-and-packaging.md) beschrieben und führst dann `npm run cli -- <command> [options]` aus.

## Befehle {#commands}

### `openscreen record` {#openscreen-record}

Um den Bildschirm über die Kommandozeile aufzunehmen, führe `record` aus. Der Befehl nutzt denselben Aufnahme-Hook wie die Desktop-App, und die Dateien landen im Aufnahmeverzeichnis der App, neben den Aufnahmen aus der GUI: das Bildschirmvideo und, wenn Zeigerdaten erfasst wurden, eine Cursor-Telemetriedatei `<video>.cursor.json`, die der bearbeitbare Cursor und `--auto-zoom` auslesen.

```bash
openscreen record --duration 30 --project demo.openscreen --json
openscreen record --window "My App" --mic --system-audio
openscreen record --display 1 --cursor system
```

| Option | Bedeutung |
|---|---|
| `--display <n>` | Bildschirmindex, wie von `openscreen sources` aufgelistet (Standard 0) |
| `--window <title>` | Das erste Fenster aufnehmen, dessen Titel `<title>` enthält, ohne Beachtung der Groß-/Kleinschreibung. Hat Vorrang vor `--display` |
| `--mic` | Das Standardmikrofon aufnehmen |
| `--mic-device <name>` | Das Mikrofon aufnehmen, dessen Bezeichnung `<name>` enthält, ohne Beachtung der Groß-/Kleinschreibung. Schließt `--mic` ein |
| `--system-audio` | Systemaudio aufnehmen |
| `--cursor <editable-overlay\|system>` | `editable-overlay` (Standard) blendet den Systemzeiger aus und zeichnet ihn als Daten auf, damit der Editor ihn neu gestalten kann. `system` zeichnet den Zeiger ins Video |
| `--duration <seconds>` | Nach dieser Dauer automatisch stoppen |
| `--project <out.openscreen>` | Am Ende eine Projektdatei schreiben, die auf die Aufnahme verweist, bereit für `export` oder den Editor. Muss auf `.openscreen` enden |
| `--json` | NDJSON-Ereignisse auf stdout |

Eine Webcam-Option gibt es nicht: Eine CLI-Aufnahme enthält nur Bildschirm und Audio.

**Stoppen.** Ohne `--duration` stoppst du eine Aufnahme mit Ctrl+C (SIGINT), mit SIGTERM oder indem du `stop`, `q` oder `quit` und Enter auf ihrem stdin eingibst. Das Schließen von stdin stoppt sie nicht. Ein erzwungenes Beenden überspringt den normalen Abschluss, es wird also weder ein `done`-Ereignis noch eine Projektdatei geschrieben.

**Je Plattform**

- **macOS.** Die Aufnahme läuft über das ScreenCaptureKit-Hilfsprogramm, ohne Fallback. Die Berechtigung „Bildschirmaufnahme“ ist erforderlich; bei einem Entwicklungs-Build, der aus einem Terminal gestartet wird, erteilst du sie dem Terminal. Mit `--mic` fragt die CLI nach Mikrofonzugriff, falls er noch nicht erteilt ist. Klicks und Formen des Zeigers werden nur mit der Berechtigung „Bedienungshilfen“ aufgezeichnet.
- **Windows.** Die Aufnahme läuft über das Hilfsprogramm für Windows Graphics Capture, ab Windows 10 Build 19041. Auf älteren Builds oder ohne das Hilfsprogramm weicht OpenScreen auf die Browser-Aufnahme aus. Windows liefert nie SIGTERM: Nimm Ctrl+C, `stop` über stdin oder `--duration`.
- **Linux.** Die Aufnahme läuft über das PipeWire-Hilfsprogramm und das ScreenCast-Portal des Desktops. Die eigene Auswahl des Portals entscheidet, was aufgenommen wird, und sie öffnet sich bei jedem Lauf und wartet auf eine Antwort. `--display` und `--window` wählen die Quelle also nicht, und eine Linux-Aufnahme kann nicht unbeaufsichtigt starten. Sie braucht eine Desktop-Sitzung mit `xdg-desktop-portal`: Eine SSH-Sitzung ohne Display kann nicht aufnehmen. Nur ein Build ohne das Hilfsprogramm weicht auf die Aufnahme von Chromium aus.

### `openscreen sources` {#openscreen-sources}

Listet die Bildschirme, Fenster und Mikrofone auf, die die App sieht, damit ein Skript Werte für `--display`, `--window` und `--mic-device` wählen kann. Unter Linux entscheidet trotzdem die Portal-Auswahl, was `record` aufnimmt.

```bash
openscreen sources                   # human-readable
openscreen sources --json            # NDJSON on stdout
openscreen sources -o sources.json   # payload written to a file
```

Mit `--json` kommen die Nutzdaten im abschließenden `done`-Ereignis an:

```json
{
  "event": "done",
  "success": true,
  "sources": {
    "displays": [{ "index": 0, "id": "screen:1:0", "name": "Entire screen" }],
    "windows": [{ "id": "window:210:0", "name": "My App" }],
    "microphones": [{ "label": "Built-in Microphone" }],
    "microphoneLabelsUnavailable": false
  }
}
```

`microphoneLabelsUnavailable` ist `true`, wenn die Gerätenamen eine Berechtigung brauchen, die nicht erteilt wurde, oder wenn die Geräteliste nicht innerhalb weniger Sekunden gelesen werden konnte.

**Wozu `-o` da ist.** Die CLI schreibt nur ihre eigene Ausgabe auf stdout; die Diagnosemeldungen von Chromium gehen auf stderr. Der Wrapper um den Prozess ist eine andere Sache. Ubuntus `xvfb-run`, der übliche Weg, ein GUI-Programm auf einem Rechner ohne Bildschirm auszuführen, führt stderr mit stdout zusammen. Die Startwarnungen von Chromium landen dann vor dem JSON, und `openscreen sources --json | jq` schlägt fehl. `-o <file>` schreibt an eine Stelle, die kein Wrapper umleiten kann, und umgeht Unterschiede bei Shell-Quoting und Zeichenkodierung.

Die beiden Kanäle liefern die Daten in unterschiedlicher Form. stdout verpackt die Nutzdaten im `done`-Ereignis, weil sie ein Ereignis in einem Stream sind. Die Datei enthält nur die Nutzdaten:

```bash
openscreen sources --json | jq 'select(.event == "done") | .sources.displays'   # stdout: inside the envelope
openscreen sources -o s.json && jq '.displays' s.json                             # file: the payload itself
```

Die Datei wird nur bei Erfolg geschrieben, und zwar atomar: Ein fehlgeschlagener Lauf lässt eine frühere Datei unverändert. Prüfe den Exit-Code, nicht ob die Datei existiert.

### `openscreen export` {#openscreen-export}

Rendert ein Projekt als MP4 oder GIF, mit dem nativen Compositor, den der Editor für Vorschau und Export nutzt. Zooms, Schnitte, Geschwindigkeitsbereiche, Annotationen und Untertitel, der Cursor und der Hintergrund kommen alle aus dem Projekt.

```bash
openscreen export demo.openscreen                          # format and quality from the project
openscreen export demo.openscreen -o out.mp4 --quality source
openscreen export demo.openscreen -o out.gif --gif-fps 20 --gif-size large
openscreen export demo.openscreen -o out.mp4 --auto-zoom --json
```

| Option | Bedeutung |
|---|---|
| `-o, --out <path>` | Ausgabedatei. Die Endung, `.mp4` oder `.gif`, legt das Format fest. Standard: der Pfad des Projekts mit `.mp4` oder `.gif` |
| `--format <mp4\|gif>` | Das im Projekt gespeicherte Format überschreiben. Muss zu `--out` passen |
| `--quality <medium\|good\|source>` | Ausgabegröße: `medium` ist 720p, `good` ist 1080p, `source` richtet sich nach dem kleinsten Clip nach dem Zuschnitt und skaliert daher nie hoch. Auch ein GIF geht von dieser Größe aus |
| `--gif-fps <15\|20\|25\|30>` | Bildrate des GIF |
| `--gif-size <medium\|large\|original>` | Höhenbegrenzung des GIF, angewendet auf diese Größe: 720, 1080 oder keine |
| `--auto-zoom` | Vor dem Rendern Zooms an den Stellen hinzufügen, an denen der aufgezeichnete Zeiger innehielt, mit derselben Engine wie die [automatischen Zooms](/features/auto-zoom/) des Editors. Vorhandene Zooms bleiben erhalten, und neue überlappen sie nie |
| `--audio <file>` | Eine Voice-over-Datei (mp3, wav oder m4a) ins MP4 mischen. Nur MP4 |
| `--audio-mode <mix\|replace>` | `mix` (Standard) behält den Ton der Aufnahme mit 40 % Pegel unter dem Voice-over; `replace` entfernt ihn |
| `--audio-offset <seconds>` | Verzögerung, bevor das Voice-over beginnt (Standard 0) |
| `--json` | NDJSON für Fortschritt und Ergebnis auf stdout |

MP4-Exporte aus der CLI sind immer **H.264 mit 60 fps**. Eine Option für Codec oder Bildrate gibt es nicht. Der [Export](./export.md)-Dialog der Desktop-App bietet zusätzlich H.265 sowie 24 oder 30 fps.

`--audio` greift nach dem Rendern: Der Videostream wird unverändert kopiert, und eine neue AAC-Spur wird gemischt und über dieselbe Ausgabedatei geschrieben.

**Wo Medien liegen dürfen.** Beim Laden eines Projekts gibt die App die referenzierten Medien nur dann automatisch frei, wenn sie in ihrem Aufnahmeverzeichnis oder im Ordner der Projektdatei selbst liegen. Lege ein von Hand geschriebenes Projekt neben seine Medien, oder nimm mit der CLI auf, die das Aufnahmeverzeichnis nutzt.

**Kein Abbrechen.** Nur `record` reagiert auf eine Stoppanfrage. Einen Export gibst du nur auf, indem du den Prozess beendest; was er am Ausgabepfad hinterlassen hat, ist dann als unbrauchbar zu betrachten.

### `openscreen captions` {#openscreen-captions}

Transkribiert den Ton des Projekts mit Whisper auf deinem Rechner und schreibt dann Untertitel-Annotationen in die Projektdatei. Nichts wird hochgeladen, und die Sprache wird automatisch erkannt. Der erste Lauf lädt das Whisper-Modell einmalig herunter, etwa 264 MB, wie in der Desktop-App.

```bash
openscreen captions demo.openscreen --min-words 2 --max-words 7
openscreen export demo.openscreen -o demo.mp4   # captions are burned into the video
```

- `--min-words` und `--max-words` legen die Wörter pro Untertitel fest. Standard: 2 und 7.
- Ein erneuter Lauf ersetzt die Untertitel, die der Befehl vorher hinzugefügt hat. Annotationen, die du selbst hinzugefügt hast, bleiben erhalten.
- Das Bildschirmvideo des Projekts muss eine Audiospur haben, zum Beispiel aus `record --mic`.
- Untertitel werden in den Export eingebrannt. Eine Ausgabe als Untertiteldatei gibt es nicht. Siehe [Untertitel](./captions.md).

### `openscreen pack` {#openscreen-pack}

Kopiert ein Projekt und alles, worauf es verweist (Bildschirmvideo, Webcam-Video, Cursor-Telemetrie), in einen Ordner und schreibt die Medienpfade im kopierten Projekt um.

```bash
openscreen pack demo.openscreen --out bundle/
```

`-o` wird als Kurzform von `--out` akzeptiert, das Pflicht ist. Der Ordner kann verschoben oder als CI-Artefakt aufbewahrt werden: Wenn die gespeicherten absoluten Pfade nicht mehr existieren, greift die App auf gleichnamige Dateien neben der Projektdatei zurück.

### `openscreen info` {#openscreen-info}

Gibt aus, worauf ein Projekt verweist und ob sein Bildschirmvideo noch existiert, dazu seine Exporteinstellungen und wie viele Zooms, Schnitte, Geschwindigkeitsbereiche und Annotationen es enthält.

```bash
openscreen info demo.openscreen --json
```

Der Befehl endet mit Exit-Code 1, wenn das referenzierte Bildschirmvideo fehlt.

## Maschinenlesbare Ausgabe {#machine-readable-output}

Mit `--json` enthält stdout ein JSON-Objekt pro Zeile. stderr enthält nur Diagnosemeldungen, einschließlich der Log-Zeilen der App selbst.

```json
{"event":"started","command":"export"}
{"event":"progress","percentage":50,"currentFrame":60,"totalFrames":120,"estimatedTimeRemaining":3}
{"event":"done","success":true,"outputPath":"/path/out.mp4","format":"mp4","width":1920,"height":1080}
```

| Ereignis | Wird gesendet, wenn | Felder |
|---|---|---|
| `started` | ein Lauf von `record`, `sources`, `export` oder `captions` beginnt | `command` |
| `log` | eine Statuszeile anfällt, etwa `Recording started` | `message` |
| `progress` | Export-Frames kodiert werden | `percentage`, `currentFrame`, `totalFrames`, `estimatedTimeRemaining` in Sekunden. Während `--audio` gemischt wird: `percentage` und `phase: "mixing-voiceover"` |
| `stopping` | `record` eine Stoppanfrage erhalten hat | `reason`: `SIGINT`, `SIGTERM` oder `stdin` |
| `warning` | der Lauf mit einer Einschränkung erfolgreich war | `message` |
| `error` | ein Fehler gemeldet wurde | `message` |
| `done` | der Lauf beendet ist, ob erfolgreich oder nicht | `success`, dann das Ergebnis oder `error` |

Was `done` enthält:

- **export:** `outputPath`, `format`, `width`, `height`.
- **record:** `screenVideoPath`, `cursorDataPath` (wohin die Telemetriedatei geschrieben wird; sie existiert eventuell nicht), `durationMs`; mit `--project` außerdem `projectPath` und `projectData`, das geschriebene Projekt.
- **sources:** `sources`.
- **captions:** `projectPath`, `captionCount`.
- **pack:** `projectPath`, `files`, `cursorData`. `pack` sendet kein `started`-Ereignis.

`info --json` gibt ein einzelnes Übersichtsobjekt ohne Feld `event` aus.

Ein fehlgeschlagenes `pack` oder `info` endet mit einem `error`-Ereignis ohne `done`. Ein Absturz kann mit einem `error`-Ereignis enden oder ganz ohne weitere Ausgabe auf stdout. Verlass dich auf den Exit-Code.

**Exit-Codes**

| Code | Bedeutung |
|---|---|
| `0` | Erfolg |
| `1` | Fehler, auch bei `info` für ein Projekt, dessen Bildschirmvideo fehlt |
| `2` | Ungültige Argumente. Meldung und Hilfetext gehen als reiner Text auf stderr, auch mit `--json` |

## Beispiel: eine automatisierte Produktdemo {#example-an-automated-product-demo}

Ein Skript oder ein Coding-Agent kann eine untertitelte Demo mit Zooms erstellen, ohne den Editor zu öffnen:

```bash
# 1. Record 20 seconds of one window, with narration from the microphone
openscreen record --window "MyProduct" --mic --duration 20 --project demo.openscreen --json

# 2. Caption the narration on this machine
openscreen captions demo.openscreen --json

# 3. Add a manual zoom and a text label by editing the project JSON
node -e '
  const fs = require("fs");
  const p = JSON.parse(fs.readFileSync("demo.openscreen", "utf8"));
  p.editor.zoomRegions.push({ id: "z1", startMs: 2000, endMs: 6000, depth: 3,
    focus: { cx: 0.5, cy: 0.4 }, focusMode: "manual", source: "manual" });
  p.editor.annotationRegions.push({ id: "a1", startMs: 500, endMs: 4000,
    type: "text", content: "One-click setup", textContent: "One-click setup",
    position: { x: 8, y: 6 }, size: { width: 40, height: 12 },
    style: { fontSize: 24, color: "#fff" }, zIndex: 1 });
  fs.writeFileSync("demo.openscreen", JSON.stringify(p, null, 2));
'

# 4. Render, with automatic zooms added where the pointer paused
openscreen export demo.openscreen -o demo.mp4 --auto-zoom --json
```

In Schritt 3 reicht `depth` von 1 bis 6 (1.25× bis 5×; 3 entspricht 1.8×), und `cx` und `cy` legen die Zoommitte als Anteile des Bildes fest.

Soll stattdessen eine Text-to-Speech-Engine sprechen, nimmst du ohne `--mic` auf und mischst das Voice-over beim Export hinzu. Jede Engine, die mp3, wav oder m4a schreibt, funktioniert; hier das `say` von macOS:

```bash
say -o voice.m4a --file-format=m4af "Welcome to MyProduct. Here is a quick tour."
openscreen export demo.openscreen -o demo.mp4 --auto-zoom --audio voice.m4a --audio-mode replace
```

`captions` liest die eigene Audiospur der Aufnahme, nicht ein beim Export hinzugemischtes Voice-over. Eine Text-to-Speech-Sprachspur bekommt auf diesem Weg also keine Untertitel.

**Ein Video aus einem anderen Tool exportieren.** `export` braucht keine OpenScreen-Aufnahme. Das kleinste Projekt, das der Befehl akzeptiert, ist ein Medienpfad und ein leerer Editor. Daraus wird ein Clip über die volle Länge mit Standardeinstellungen:

```json
{
  "version": 2,
  "media": { "screenVideoPath": "/path/to/clip.mp4" },
  "editor": {}
}
```

Speichere das Projekt im selben Ordner wie den Clip. Ohne Cursor-Telemetrie hat `--auto-zoom` nichts, womit es arbeiten kann.

## Displays, CI und Server {#displays-ci-and-servers}

- Jeder Befehl startet Electron, das wiederum Chromium startet. Ein Displayserver muss also vorhanden sein, auch wenn sich kein Fenster öffnet. Auf einem Linux-Rechner ohne Bildschirm stellt ihn ein virtueller X-Server bereit, gestartet mit `xvfb-run`.
- `export` nimmt nichts auf und funktioniert deshalb auf diese Weise, sofern ein Vulkan-Treiber vorhanden ist: Der Linux-Compositor rendert über Vulkan, und ein Rechner ohne GPU braucht einen Software-Treiber wie lavapipe von Mesa. Der Nix-Build-Workflow des Projekts rendert auf diese Weise ein MP4 aus einem erzeugten Clip, unter `xvfb-run` mit lavapipe auf einem Linux-Runner ohne Bildschirm, und schlägt fehl, wenn kein MP4 herauskommt.
- `record` funktioniert so nicht. Auf demselben Runner findet Chromium kein Display, das es aufnehmen könnte, und unter Linux braucht die Portal-Auswahl ohnehin einen Menschen.

## Wann die CLI nicht das richtige Werkzeug ist {#when-the-cli-is-not-the-right-tool}

- **Du musst auf einem Server aufnehmen**, ohne Display oder Desktop-Sitzung. Die Aufnahme braucht einen echten Desktop, und unter Linux muss bei jedem Lauf jemand die Portal-Auswahl beantworten.
- **Du brauchst eine stabile, versionierte API.** Die CLI und das Projektformat können sich zwischen Versionen noch ändern.
- **Du willst Codec, Bildrate oder Bitrate über die Kommandozeile steuern.** CLI-MP4-Exporte sind H.264 mit 60 fps, und die MP4-Bitrate lässt sich auch in der App nicht einstellen.
- **Du brauchst die Webcam in einer skriptgesteuerten Aufnahme.** `record` hat keine Kamera-Option.
- **Du brauchst Untertiteldateien.** Untertitel werden nur ins Video eingebrannt.

Eine praktische Anleitung mit denselben Schritten im Editor findest du unter [So erstellst du ein Produktdemo-Video](./guides/product-demo-video.md). Antworten zu Lizenz und Netzwerknutzung stehen in der [FAQ](./faq.md).

## Quellcode {#source-code}

Die CLI ist Teil des [OpenScreen-Repositorys](https://github.com/getopenscreen/openscreen):

- `electron/cli/args.ts`: der Argument-Parser und der Hilfetext, mit Unit-Tests in `args.test.ts`.
- `electron/cli/cliMain.ts`: der Start ohne Fenster, das stdio-Protokoll, Stoppsignale und Exit-Codes.
- `electron/cli/projectCommands.ts`: `pack` und `info`.
- `src/cli/`: die Runner in versteckten Fenstern für `record`, `sources`, `export` und `captions`.
- `src/lib/cliContracts.ts`: die Anfrage- und Ergebnistypen, die beide Seiten teilen.
