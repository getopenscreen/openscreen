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

Der Eintrag **Smart cuts** (mit *With AI* markiert) im Menü **Auto-enhance** der Zeitleiste ist derselbe Agent mit einer einmaligen Anweisung. (Der andere Eintrag, **Automatic zooms**, liest die aufgezeichneten Klicks und braucht überhaupt keinen Anbieter.)

## Was deinen Anbieter sonst noch nutzt {#what-else-uses-your-provider}

Die [Untertitelübersetzung](./captions.md#translation) ist ein einzelner Aufruf zur Textumwandlung an dasselbe Modell. Sie startet keine Agentenschleife und kann dein Dokument nicht verändern. Transkription und Untertitel-Rendering bleiben in jedem Fall vollständig auf deinem Gerät.

## Claude Code, Codex oder einen anderen MCP-Client nutzen {#using-claude-code-codex-or-another-mcp-client}

Wenn du bereits einen KI-Coding-Agenten wie Claude Code oder Codex nutzt, kann er dieselben Bearbeitungswerkzeuge steuern, angemeldet mit seinem eigenen Konto. Nichts von diesem Konto läuft über OpenScreen.

1. **AI settings** → **MCP server** → einschalten. Er lauscht nur auf deinem eigenen Rechner (`127.0.0.1`), auf dem angezeigten Port.
2. Kopiere den dort angezeigten Befehl für **Claude Code** oder **Codex** und führe ihn in einem Terminal aus. Der Befehl für Claude Code enthält das Zugriffstoken. Codex liest es stattdessen aus der Umgebungsvariable `OPENSCREEN_MCP_TOKEN`: Setze sie in der Shell, aus der du Codex startest.
3. Lass ein Projekt im OpenScreen-Editor geöffnet und bitte dann deinen Agenten um die Änderung.

Die Werkzeuge sind die, die der eingebaute Agent nutzt, und sie wirken auf das im Editor geöffnete Projekt. MCP-Clients können das Projekt nur **lesen**, bis du im Abschnitt MCP-Server auch **Project edits** einschaltest; dieser Schalter ist von dem des eingebauten Agenten getrennt und steht anfangs auf aus. Ist er an, wird jede Änderung gespeichert, sobald sie ankommt, und mit `Ctrl/Cmd + Z` rückgängig gemacht. Clients werden angewiesen, vor einer Reihe von Änderungen einen Wiederherstellungspunkt zu speichern. So kannst du sie bitten, das Projekt in einem einzigen Schritt wiederherzustellen, wie es war, und auch diesen Schritt kann `Ctrl/Cmd + Z` rückgängig machen. Wenn du das Token mit **Regenerate** ersetzt, werden alle Clients getrennt, die mit dem alten eingerichtet wurden.

## Einen Agenten das ganze Video erstellen lassen {#letting-an-agent-make-the-whole-video}

Der Server oben bearbeitet Projekte. Soll ein Agent ein ganzes Video selbstständig erstellen, von der Aufnahme bis zum Export, füge OpenScreen stattdessen als stdio-Server zum Agenten hinzu: Der Agent startet die eigene ausführbare Datei der App mit `mcp`. Er bekommt dieselben Bearbeitungswerkzeuge, dazu `listSources`, `startRecording`, `stopRecording`, `setPointerTrack`, `exportVideo` und `getFrames`.

```bash
claude mcp add openscreen -- "/Applications/Openscreen.app/Contents/MacOS/Openscreen" mcp
codex mcp add openscreen -- "/Applications/Openscreen.app/Contents/MacOS/Openscreen" mcp
```

Die ausführbare Datei für jedes System steht unter [Die CLI ausführen](./cli.md#running-the-cli).

- **Kein Port, kein Token, keine Einstellung.** Der Agent startet den Prozess selbst, mit deinen Rechten, so wie er `openscreen record` ausführen würde. Deshalb kann er deinen Bildschirm aufnehmen und bearbeiten, ohne den Schalter **Project edits**.
- **Jeder Take wird zu einem neuen Projekt** in deiner Projektliste, mit einem Zoom auf jeden aufgezeichneten Klick, wie eine in der App gemachte Aufnahme. Bearbeite es nicht im Editor, solange der Agent noch daran arbeitet: Der Editor hält seine eigene Kopie.
- **Ein per Skript gesteuerter Take** (zum Beispiel mit Playwright) bewegt nie den Zeiger auf dem Bildschirm. Der Agent übergibt OpenScreen mit `setPointerTrack` sein eigenes Protokoll der Aktionen, und das Video bekommt trotzdem einen Cursor und dessen Zooms.
- **Der Skill `openscreen-demo`** bringt einem Agenten die ganze Arbeit bei, vom Storyboard bis zu einem Post auf X, den er erst veröffentlicht, wenn du Ja sagst. Füge ihn mit `npx skills add getopenscreen/openscreen --skill openscreen-demo` hinzu. Das Rezept ist [`skills/openscreen-demo/SKILL.md`](https://github.com/getopenscreen/openscreen/blob/main/skills/openscreen-demo/SKILL.md).
