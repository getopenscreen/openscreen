---
id: ai-editing
title: KI-Bearbeitung
sidebar_position: 8
description: "Mit eigenem LLM-Schlüssel OpenScreen-Projekte im Chat bearbeiten. Optional und standardmäßig aus: Ohne Verbindung wird nichts an ein Modell gesendet."
keywords:
  - KI-Videobearbeitung
  - LLM-Videoeditor
  - Bearbeitung per Chat
  - eigener API-Schlüssel
  - Datenschutz
---

# KI-Bearbeitung

OpenScreen bringt einen optionalen Agenten mit, der dein Projekt über einen Chat-Bereich bearbeitet. Er ist **aus, bis du selbst einen Anbieter verbindest**, und vorher wird nichts an ein Modell gesendet. Nach dem Verbinden spricht der Agent nur mit diesem Anbieter, genau wie die [Untertitelübersetzung](./captions.md#translation). Die übrige Netzwerknutzung der App (Download des Whisper-Modells, Schriften für Annotationen, Suche nach Updates) ist in der [Einführung](./intro.md) aufgeführt.

:::tip
Nichts davon ist erforderlich. Aufnahme, Bearbeitung, Transkription, Untertitel und Export funktionieren alle ohne Konto und ohne Anbieter, egal, ob du den Chat-Bereich jemals öffnest. Davon braucht nur die Transkription einen Download, und zwar einmalig: das [Whisper-Modell](./captions.md#transcribing) beim ersten Durchlauf.
:::

## Einen Anbieter verbinden {#connecting-a-provider}

Öffne die Chat-Spalte (über den Schalter ganz links in der oberen Leiste, im Modus **Edit**), dann **AI settings** → wähle einen Anbieter und füge einen API-Schlüssel ein:

| Anbieter | Hinweise |
|---|---|
| **Claude API** (Anthropic) | |
| **OpenAI API** | |
| **Gemini API** (Google) | |
| **Mistral API** | |
| **OpenRouter API** | Ein Schlüssel, viele Modelle. |
| **MiniMax API** / **MiniMax Token Plan** | |
| **OpenAI Compatible** | Jeder Endpunkt mit OpenAI-kompatibler API; die Basis-URL gibst du selbst an. |

Dein Schlüssel wird verschlüsselt über den Schutz für Zugangsdaten deines Betriebssystems gespeichert (Electron `safeStorage`). Ist keine Verschlüsselung verfügbar, schlägt das Speichern fehl, statt auf Klartext auszuweichen. Die Server von OpenScreen sehen den Schlüssel nie, denn es gibt keine: Anfragen gehen direkt von deinem Rechner an den gewählten Anbieter. Anbieterspezifische Umgebungsvariablen funktionieren ebenfalls, falls du gar keinen Schlüssel speichern willst.

:::note
Die Anmeldeoptionen für ChatGPT und GitHub Copilot wurden **in 1.8.0 entfernt**. Sie funktionierten, indem die App Client-Zugangsdaten dieser Anbieter mitlieferte, und die dürfen wir nicht weitergeben. Nutze stattdessen einen Anbieter mit API-Schlüssel.
:::

## Den Agenten nutzen {#using-the-agent}

Beschreibe die Änderung in Alltagssprache, etwa „schneide die Stille im Intro heraus“ oder „zoome hinein, wenn ich das Terminal öffne“. Der Agent arbeitet mit echten, rückgängig machbaren Operationen auf der Zeitleiste, nicht mit einem neuen Rendering: Er kann Schnitte, Zooms, Geschwindigkeitsbereiche, Annotationen und Full-Camera-Segmente hinzufügen und anpassen, Start- und Endpunkte von Clips ändern, Clips umsortieren oder entfernen und das Transkript lesen, um herauszufinden, was du meinst.

Der Bereich drumherum:

- **Unterhaltungen**: Verlauf, umbenennen, löschen und eine neue beginnen. Jede hat ihren eigenen Agentenzustand.
- **Modellauswahl**: aktuelle Modellliste des verbundenen Anbieters, mit einer Einstellung für den Reasoning-Aufwand, wo der Anbieter das unterstützt.
- **Kontextanzeige**: geschätzte verbrauchte Tokens im Verhältnis zum Budget, mit der Aktion **Compact context**, die frühere Runden zusammenfasst, statt sie zu verwerfen.
- **Rewind to this message**: macht die Änderungen des Agenten und alle folgenden Runden ab diesem Punkt rückgängig und stellt Projekt, Unterhaltung und Agentenzustand gemeinsam wieder her.
- **Project edits**: ein Schalter in **AI settings**. Ist er aus, wird jede Änderung, die der Agent versucht, abgelehnt: Er kann das Projekt weiterhin lesen und beschreiben, was er ändern würde, wendet aber nichts an, bis du den Schalter wieder einschaltest.

`Ctrl/Cmd + Z` macht eine Änderung des Agenten genauso rückgängig wie eine manuelle.

Der Eintrag **Smart cuts** (mit *With AI* markiert) im Menü **Auto-enhance** der Zeitleiste ist derselbe Agent mit einer einmaligen Anweisung. (Der andere Eintrag, **Automatic zooms**, liest die aufgezeichnete Cursorbewegung und braucht überhaupt keinen Anbieter.)

## Was deinen Anbieter sonst noch nutzt {#what-else-uses-your-provider}

Die [Untertitelübersetzung](./captions.md#translation) ist ein einzelner Aufruf zur Textumwandlung an dasselbe Modell. Sie startet keine Agentenschleife und kann dein Dokument nicht verändern. Transkription und Untertitel-Rendering bleiben in jedem Fall vollständig auf deinem Gerät.
