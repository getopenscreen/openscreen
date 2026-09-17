---
id: intro
title: "OpenScreen-Doku: installieren, aufnehmen, bearbeiten, exportieren"
sidebar_label: Einführung
sidebar_position: 1
description: "Doku zu OpenScreen 1.11.0, Bildschirmrekorder und Editor unter MIT-Lizenz: installieren, aufnehmen, bearbeiten, untertiteln, exportieren (Windows, macOS, Linux)."
keywords:
  - Bildschirmrekorder
  - Open-Source-Bildschirmrekorder
  - kostenloser Bildschirmrekorder
  - Videoeditor
  - OpenScreen Dokumentation
  - Windows
  - macOS
  - Linux
---

# OpenScreen-Dokumentation: installieren, aufnehmen, bearbeiten, exportieren

OpenScreen ist ein **kostenloser Open-Source-Bildschirmrekorder mit Editor**. OpenScreen nimmt über die native Aufnahme-API jeder Plattform auf (ScreenCaptureKit unter macOS, Windows Graphics Capture unter Windows, PipeWire über das ScreenCast-Portal unter Linux) und setzt sowohl die Live-Vorschau als auch den finalen Export auf der GPU zusammen, mit einem nativen Renderer in Rust (Direct3D 11 unter Windows, Metal unter macOS, wgpu unter Linux). Beides läuft über denselben Weg: Was du im Editor siehst, kommt auch beim Export heraus.

Diese Seiten beschreiben **OpenScreen 1.11.0**, die stabile Version vom 9. September 2026. Was sich in jeder Version geändert hat und warum, steht im [Entwicklungstagebuch (auf Englisch)](/blog/).

:::note
OpenScreen erscheint häufig in neuen Versionen. Zwischen zwei Versionen können sich das Projektformat `.openscreen` und die [CLI](/docs/cli/) noch ändern.
:::

## Was du damit machen kannst {#what-you-can-do}

- Ein bestimmtes Fenster oder den ganzen Bildschirm [aufnehmen](./recording.md), mit Systemaudio, Mikrofon und Webcam, über ein schwebendes HUD oder direkt im Editor.
- Ein Projekt aus mehreren Quellen aufbauen: [Clips importieren, kürzen, zuschneiden, umsortieren und teilen](./media-library.md), alles auf einer Zeitleiste.
- [Bearbeiten](./editing-timeline.md) mit Zooms, Schnitten, Geschwindigkeit pro Bereich, Full-Camera-Segmenten, Annotationen (Text, Bild, Pfeil, Unschärfe), Cursor-Themes, Webcam-Layouts sowie Hintergründen und Effekten.
- Lokal mit Whisper transkribieren, dann [Untertitel einbrennen](./captions.md), live gestaltet und über deinen eigenen LLM-Anbieter in 15 Sprachen übersetzbar, oder die Aufnahme schneiden, indem du Wörter aus dem Transkript löschst.
- Optional deinen eigenen LLM-Schlüssel verbinden, um [per Chat zu bearbeiten](./ai-editing.md). Das ist standardmäßig aus und nie erforderlich.
- Als MP4 (720p/1080p/Quellauflösung, H.264 oder H.265) oder animiertes GIF [exportieren](./export.md).

Fragen zu Lizenz, Wasserzeichen oder dazu, was über das Netzwerk geht, beantwortet die [FAQ](/docs/faq/). Wie OpenScreen im Vergleich zu anderen Rekordern abschneidet, steht auf den Seiten zu [Screen Studio](/alternatives/screen-studio/), [Cap](/compare/openscreen-vs-cap/) und [OBS Studio](/compare/openscreen-vs-obs/).

:::note
Aufnahme, Bearbeitung, Transkription, Untertitel und Export brauchen kein Konto und funktionieren auch ohne Netzwerkverbindung weiter. Die Transkription braucht vorher einen Download: ihr Whisper-Modell (ca. 264 MB), das beim ersten Durchlauf geladen wird. Wenn eine Verbindung besteht, lädt die App beim Start außerdem ihre Schriften für Annotationen von Google Fonts, und über GitHub Releases installierte Versionen fragen bei GitHub nach Updates. Die Chat-Bearbeitung mit KI und die Untertitelübersetzung gehen erst online, wenn du selbst einen Anbieter verbindest, und dann nur zu diesem Anbieter.
:::

## Das Projekt in Kürze {#project-facts}

| | |
|---|---|
| **Lizenz** | MIT: kostenlos für private und kommerzielle Nutzung |
| **Dokumentierte Version** | 1.11.0 ([alle Versionen](https://github.com/getopenscreen/openscreen/releases)) |
| **Plattformen** | Windows 10 Version 1903 oder neuer (x64), macOS 13 oder neuer (Apple Silicon und Intel), Linux (x64-Pakete; aarch64 über den Nix-Flake), siehe [Installation](./installation.md) |
| **Herkunft** | Ursprünglich entwickelt von Siddharth Vaddem, der das [ursprüngliche Repository](https://github.com/siddharthvaddem/openscreen) nach v1.5.0 archiviert hat. Die Entwicklung geht hier mit seiner Zustimmung weiter, unter demselben Namen und derselben MIT-Lizenz. |

## Offizielle Links {#official-links}

| | |
|---|---|
| **Website** | [getopenscreen.com](https://getopenscreen.com/) |
| **Quellcode, Releases, Issues** | [github.com/getopenscreen/openscreen](https://github.com/getopenscreen/openscreen) |
| **Microsoft Store** | [apps.microsoft.com/detail/9MXQ1HQJL5G5](https://apps.microsoft.com/detail/9MXQ1HQJL5G5) |
| **Discord** | [getopenscreen.com/discord](https://getopenscreen.com/discord/) |

## Stand dieser Website {#status-of-this-site}

Alles unter **Funktionen** in der Seitenleiste dokumentiert, was heute tatsächlich in der App steckt, nicht die Roadmap. Die ausführlicheren internen Spezifikationen, aus denen diese Website entstanden ist (Architekturnotizen, technische Dokumentation, Testpläne), liegen noch auf Englisch im Repository und sind noch nicht hierher übertragen:

- [`README.md`](https://github.com/getopenscreen/openscreen/blob/main/README.md)
- [`CONTRIBUTING.md`](https://github.com/getopenscreen/openscreen/blob/main/CONTRIBUTING.md)
- [`AGENTS.md`](https://github.com/getopenscreen/openscreen/blob/main/AGENTS.md)
- [`docs/`](https://github.com/getopenscreen/openscreen/tree/main/docs)
