---
id: export
title: Bildschirmaufnahmen als MP4 oder GIF exportieren
sidebar_position: 9
sidebar_label: Export
description: "Aus OpenScreen als MP4 (720p, 1080p oder Quellauflösung, H.264 oder H.265) oder animiertes GIF exportieren, und wie GPU-Rendering und Encoding je System laufen."
keywords:
  - MP4 exportieren
  - H.264
  - H.265
  - animiertes GIF
  - Video exportieren
  - 1080p
---

# Bildschirmaufnahmen als MP4 oder GIF exportieren

Klicke in der oberen Leiste auf **Export**, um den Exportdialog zu öffnen.

## Formate {#formats}

- **MP4**: Qualität **720p**, **1080p** oder **Source**; Bildrate 24 / 30 / 60 fps; Codec **H.264** (Standard und von mehr Playern unterstützt) oder **H.265**.
- **GIF**: Bildrate 15 / 20 / 25 / 30 fps, Größe Medium / Large / Original und ein Schalter **Loop**.

:::note
VP9 wurde entfernt. Die GPUs, auf die die native Pipeline zielt, haben keinen VP9-Hardware-Encoder, und der Software-Fallback war viel zu langsam, um ihn als Option anzubieten, die wie die anderen aussieht.
:::

## Auflösung {#resolution}

Der Dialog zeigt die genaue Pixelgröße, die jede Qualitätsstufe beim Seitenverhältnis deiner Zeitleiste ergibt.

**Source** richtet sich nach der tatsächlichen Größe des *kleinsten* Clips nach dem Zuschnitt. Damit ist Hochskalieren schon konstruktionsbedingt ausgeschlossen: Kein Clip auf der Zeitleiste wird je über seine echte Auflösung hinaus gestreckt. Die festen Stufen 720p und 1080p peilen dagegen in jedem Fall eine bestimmte kurze Seite an und können einen kleinen Clip deshalb hochskalieren. Der Dialog kennzeichnet die Stufe, wenn das passieren würde.

## Exportieren {#exporting}

1. Stelle Format und Qualität ein und klicke auf **Export**.
2. Wähle im Dateidialog des Systems einen Speicherort.
3. Der Dialog zeigt den echten Fortschritt des Encoders: gerenderte Frames und Gesamtzahl, dazu eine geschätzte Restzeit, danach eine Schreibphase.
4. Bei Erfolg springst du mit **Show in folder** direkt zur Datei.

Schlägt beim Rendern oder Schreiben etwas fehl, zeigt der Dialog den Fehler an, damit du es erneut versuchen kannst.

## Wie MP4 gerendert wird {#how-mp4-is-rendered}

Der MP4-Export läuft über denselben nativen Rust-Compositor, der die Live-Vorschau zeichnet (Direct3D 11 unter Windows, Metal unter macOS, wgpu/WGSL unter Linux), Clip für Clip, auf einem einzigen GPU-Gerät: Demux → Decode → Compositing → Encode → Mux. Unter Windows übernehmen die Encoder von AMD (AMF) und NVIDIA (NVENC) das zusammengesetzte Bild direkt von der GPU, ohne Rücklesen über die CPU dazwischen; Intel Quick Sync, Media Foundation und der Software-Fallback bekommen eine Kopie im Arbeitsspeicher. Unter macOS kodiert VideoToolbox: Ein H.264-Export wird direkt in den Puffer des Encoders gerendert, wenn VideoToolbox das zulässt, während der Wiederholungspfad für H.264, jeder H.265-Export und der Software-Fallback eine Kopie im Arbeitsspeicher bekommen. Unter Linux geht ein H.264-Export über VAAPI an den GPU-Encoder, ebenfalls ohne CPU-Kopie, wenn der Treiber-Stack das zulässt; andernfalls, und bei jedem H.265-Export, wird das Bild zurückgelesen und in Software kodiert. Die Vorschau pausiert während des Exports, damit sich beide nicht um die GPU streiten.

Da Vorschau und Export dieselbe Szenenbeschreibung verwenden, ist das Bild, das du siehst, auch das Bild, das du bekommst. Es gibt keinen separaten Export-Renderer, der davon abweichen könnte.

:::note Plattformunterstützung
Export als MP4 und als GIF funktioniert unter Windows, macOS und Linux. Unterschiede gibt es bei der Geschwindigkeit unter Linux: H.264 nutzt die GPU nur, wenn VAAPI und das Vulkan-Gerät es unterstützen, und H.265 wird immer in Software kodiert, deshalb dauern diese Exporte dort länger. Der Hinweis [MP4-Export unter Linux](./installation.md#platform-differences) listet, was der GPU-Pfad braucht.
:::

## Exportierte Datei und Projektdatei {#exported-file-vs-project-file}

Der Export erzeugt ein fertiges Video (oder GIF) mit zusammengeführten Ebenen, das danach nicht mehr bearbeitbar ist. Wenn du später weiterbearbeiten willst, speichere stattdessen ein `.openscreen`-**Projekt** (siehe [Bearbeitung & Zeitleiste](./editing-timeline.md#saving-your-work)). Projektdateien behalten jeden Clip, jeden Zoom, jeden Schnitt, jede Annotation und jede Einstellung unverändert bei.
