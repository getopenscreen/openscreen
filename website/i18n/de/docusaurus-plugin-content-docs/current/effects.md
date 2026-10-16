---
id: effects
title: Eigene Effekte
description: "Bitte einen KI-Agenten um einen visuellen Effekt, den die Einstellungen nicht bieten. Er schreibt einen GPU-Shader, den OpenScreen in der Vorschau und in jedem Export zeichnet."
keywords:
  - eigene Videoeffekte
  - Shader-Effekte
  - WGSL
  - KI-Videoeffekte
  - GPU-Effekte
---

# Eigene Effekte

Wenn die Einstellungen den Look nicht haben, den du suchst, bitte einen Agenten darum: eine Welle bei jedem Klick, eine Vignette, die atmet, eine Abblende ins Schwarze in den letzten Sekunden. Der Agent schreibt den Effekt als kleinen GPU-Shader, und OpenScreen zeichnet ihn in der Vorschau und in jedem Export, MP4 wie GIF, unter Windows, macOS und Linux.

Effekte kommen von einem Agenten: dem eingebauten Chat oder einem MCP-Client wie Claude Code oder Codex (siehe [KI-Bearbeitung](./ai-editing.md)). Sobald ein Effekt im Projekt ist, stellst du ihn selbst im Editor ein.

## Einen Effekt anfragen {#asking-for-an-effect}

Beschreibe, was du sehen willst, und wann: „eine Welle bei jedem Klick“, „Abblende ins Schwarze über die letzten zwei Sekunden, Untertitel inklusive“. Der Agent schreibt den Effekt, legt ihn auf die Zeitleiste und kann sich das Ergebnis mit `getFrames` ansehen, ohne das Video zu exportieren.

Ein Effekt weiß, wo der Cursor ist und wo jeder Klick gelandet ist, wo die Aufnahme und die Webcam nach Zooms und Layout im Video sitzen, und welcher Zeitpunkt gerade ist. So kann ein Lichthof der Maus folgen, und eine Welle kann von jedem Klick ausgehen, wohin der Zoom ihn auch verschoben hat.

## Im Editor {#in-the-editor}

Effekte bekommen eine eigene Reihe auf der Zeitleiste, unter den Full-Camera-Segmenten, sobald das Projekt einen enthält. Jeder Block trägt den Namen des Effekts. Verschiebe ihn, ändere seine Größe, kopiere und füge ihn ein oder lösche ihn wie jeden anderen Bereich, und `Ctrl/Cmd + Z` macht die Änderung rückgängig. Es läuft immer nur ein Effekt: Einfügen auf einen anderen Effekt wird abgelehnt.

Klicke auf einen Block, um seinen Inspektor zu öffnen:

- **Ein Regler für jede Einstellung**, die der Agent dem Effekt gegeben hat: ein Schieberegler, ein Schalter, eine Farbe oder ein Punkt.
- **Gilt für**, also wo der Effekt gezeichnet wird:
  - **Bild**, die Voreinstellung: die Aufnahme, die Webcam, der Cursor und der Hintergrund, unter deinen Annotationen und Untertiteln, die lesbar bleiben.
  - **Texte**: nur die Annotationen und Untertitel.
  - **Beides**: das ganze Bild, Text inklusive, für eine Abblende ins Schwarze, die auch die Untertitel bedeckt.
- **Kosten**: **Leicht**, **Mittel**, **Schwer** oder **Sehr schwer** (siehe [unten](#cost)).
- **Code**: der Shader, schreibgeschützt, mit **Code kopieren**. Um ihn zu ändern, bitte den Agenten darum.

Ein kopierter Effekt, der in ein anderes Projekt eingefügt wird, bringt seinen Code mit.

## Kosten {#cost}

Die Kosten werden aus dem Code geschätzt: Gezählt wird, wie oft der Effekt das Bild pro Pixel liest. Derselbe Code bekommt auf jedem Computer dieselbe Stufe. Nichts wird wegen seiner Kosten abgelehnt: Je schwerer der Effekt, desto kürzer der Abschnitt, der zu ihm passt.

| Stufe | Typische Effekte | Passt für |
|---|---|---|
| **Leicht** | Vignette, Farbkorrektur, Welle beim Klick | das ganze Video |
| **Mittel** | chromatische Aberration, leichte Unschärfe, Glitch | einige Dutzend Sekunden |
| **Schwer** | starke Unschärfe, Bokeh | einen Übergang, einen Höhepunkt |
| **Sehr schwer** | Raymarching, Simulationen | wenige Sekunden: Der Export bleibt exakt, aber langsamer, und die Vorschau kann auf einer kleinen GPU langsamer werden |

## Wenn ein Effekt nicht kompiliert {#if-an-effect-doesnt-compile}

Der Code eines Agenten wird kompiliert, bevor der Effekt angenommen wird. Code, der scheitert, wird mit dem Fehler des Compilers abgelehnt, und das Projekt ändert sich nicht.

Ein Projekt, das auf einem anderen Computer geöffnet wird, kann trotzdem auf einen Compiler treffen, der anderer Meinung ist. Der Effekt wird dann nicht gezeichnet, sein Inspektor zeigt **Lässt sich auf diesem Computer nicht kompilieren** mit dem Fehler, und der Export läuft ohne ihn weiter.

## Projekte von anderen {#projects-from-someone-else}

Ein Projekt trägt den Code seiner Effekte: Öffnest du das Projekt eines anderen, führst du also Code aus, den du nicht geschrieben hast. Dieser Code läuft nur auf der GPU, ohne Zugriff auf deine Dateien, das Netzwerk oder den Speicher der App.

## Für Agent-Entwickler {#for-agent-authors}

Die Werkzeuge sind `addEffect`, `setEffect`, `setEffectDefinition` und `getEffect`, und `removeModifier` entfernt einen Effekt. Der vollständige Vertrag, also die Funktion `effect(uv)`, was sie lesen kann und ihre Regeln, ist die MCP-Ressource `openscreen://effects/contract`.
