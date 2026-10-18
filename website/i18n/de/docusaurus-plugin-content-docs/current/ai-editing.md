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

OpenScreen bringt einen optionalen Agenten mit, der dein Projekt über einen Chat-Bereich bearbeitet. Er ist **aus, bis du selbst einen Anbieter verbindest**, und vorher wird nichts an ein Modell gesendet. Nach dem Verbinden spricht der Agent nur mit diesem Anbieter, genau wie die [Untertitelübersetzung](./captions.md#translation). Die übrige Netzwerknutzung der App (Download der Transkriptionsmodelle, Suche nach Updates) ist in den [FAQ](./faq.md#does-openscreen-work-offline) aufgeführt.

:::tip
Nichts davon ist erforderlich. Aufnahme, Bearbeitung, Transkription, Untertitel und Export funktionieren alle ohne Konto und ohne Anbieter, egal, ob du den Chat-Bereich jemals öffnest. Davon braucht nur die Transkription einen Download, und zwar einmalig: ihre [Modelle](./captions.md#transcribing) beim ersten Durchlauf.
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

Beschreibe die Änderung in Alltagssprache, etwa „schneide die Stille im Intro heraus“ oder „zoome hinein, wenn ich das Terminal öffne“. Der Agent arbeitet mit echten, rückgängig machbaren Operationen auf der Zeitleiste, nicht mit einem neuen Rendering: Er kann Schnitte, Zooms, Geschwindigkeitsbereiche, Annotationen (Text, Pfeile und Unschärfen, die private Details auf dem Bildschirm verbergen), importierte Audiospuren samt Ein- und Ausblendung und Full-Camera-Segmente hinzufügen und anpassen, automatische Zooms auf deine Klicks setzen, Start- und Endpunkte und den Zuschnitt eines Clips ändern, Material einer anderen Quelle platzieren, Clips duplizieren, umsortieren oder entfernen und das Transkript lesen, um herauszufinden, was du meinst. Außerdem stellt er das Aussehen des Videos ein: Hintergrund, Innenabstand, abgerundete Ecken, Schatten, Geräterahmen, Format, das Kamera-Layout, den Cursor und die Gesamtlautstärke. Er kann außerdem die [Untertitel](./captions.md) einschalten, gestalten und platzieren und sie selbst in eine andere Sprache übersetzen. Und er kann einen visuellen Effekt schreiben, den die Einstellungen nicht bieten: siehe [Eigene Effekte](./effects.md).

Der Bereich drumherum:

- **Unterhaltungen**: Verlauf, umbenennen, löschen und eine neue beginnen. Jede hat ihren eigenen Agentenzustand.
- **Modellauswahl**: aktuelle Modellliste des verbundenen Anbieters, mit einer Einstellung für den Reasoning-Aufwand, wo der Anbieter das unterstützt.
- **Kontextanzeige**: geschätzte verbrauchte Tokens im Verhältnis zum Budget, mit der Aktion **Compact context**, die frühere Runden zusammenfasst, statt sie zu verwerfen.
- **Rewind to this message**: macht die Änderungen des Agenten und alle folgenden Runden ab diesem Punkt rückgängig und stellt Projekt, Unterhaltung und Agentenzustand gemeinsam wieder her.
- **Agenten-Änderungen**: ein Schalter in **AI settings**. Ist er aus, wird jede Änderung, die der Agent versucht, abgelehnt: Er kann das Projekt weiterhin lesen und beschreiben, was er ändern würde, wendet aber nichts an, bis du den Schalter wieder einschaltest.

`Ctrl/Cmd + Z` macht eine Änderung des Agenten genauso rückgängig wie eine manuelle.

Der Eintrag **Smart cuts** (mit *With AI* markiert) im Menü **Auto-enhance** der Zeitleiste ist derselbe Agent mit einer einmaligen Anweisung. (Der andere Eintrag, **Automatic zooms**, liest die aufgezeichneten Klicks und braucht überhaupt keinen Anbieter.)

## Was deinen Anbieter sonst noch nutzt {#what-else-uses-your-provider}

Die [Untertitelübersetzung](./captions.md#translation) ist ein einzelner Aufruf zur Textumwandlung an dasselbe Modell. Sie startet keine Agentenschleife und kann dein Dokument nicht verändern. Bittest du im Chat darum, übersetzt der Agent die Untertitel stattdessen selbst, in dieselbe Übersetzungsebene. Transkription und Untertitel-Rendering bleiben in jedem Fall vollständig auf deinem Gerät.

## Claude Code, Codex oder einen anderen MCP-Client nutzen {#using-claude-code-codex-or-another-mcp-client}

Wenn du bereits einen KI-Coding-Agenten wie Claude Code oder Codex nutzt, kann er dieselben Bearbeitungswerkzeuge steuern, angemeldet mit seinem eigenen Konto. Nichts von diesem Konto läuft über OpenScreen.

1. **AI settings** → **MCP server** → einschalten. Er lauscht nur auf deinem eigenen Rechner (`127.0.0.1`), auf dem angezeigten Port.
2. Kopiere den dort angezeigten Befehl für **Claude Code** oder **Codex** und führe ihn in einem Terminal aus. Der Befehl für Claude Code enthält das Zugriffstoken. Codex liest es stattdessen aus der Umgebungsvariable `OPENSCREEN_MCP_TOKEN`: Setze sie in der Shell, aus der du Codex startest.
3. Bitte deinen Agenten um die Änderung, am im OpenScreen-Editor geöffneten Projekt oder an einem beliebigen anderen Projekt deiner Liste.

Die Werkzeuge sind die, die der eingebaute Agent nutzt, dazu die, die ein Video aufnehmen, exportieren und ansehen ([unten](#letting-an-agent-make-the-whole-video)). Dazu kommt `transcribe`. Es lässt Whisper auf deinem Gerät über die Medien eines Projekts laufen, wie der Editor beim Öffnen eines Projekts. Ein Client übersetzt die Untertitel mit seinem eigenen Modell, daher braucht die Untertitelübersetzung keinen Anbieter in OpenScreen. Die Werkzeuge wirken auf das im Editor geöffnete Projekt, es sei denn, der Client nennt ein anderes: Er kann alle Projekte auflisten und jedes davon lesen oder bearbeiten. Er kann auch ein Projekt anlegen, leer oder aus einer Videodatei, eines umbenennen und den Medien eines Projekts eine Video- oder Audiodatei hinzufügen oder eine daraus entfernen. Ein Projekt löschen gehört nicht zu den Werkzeugen: Das bleibt dir in der App vorbehalten. MCP-Clients können nur **lesen**, bis du im Abschnitt MCP-Server auch **MCP-Änderungen** einschaltest: Bis dahin wird jede Bearbeitung, Aufnahme, jeder Export und jedes neue Projekt, das sie versuchen, abgelehnt. Dieser Schalter ist von **Agenten-Änderungen**, dem des eingebauten Agenten, getrennt und steht anfangs auf aus. Ist er an, wird jede Änderung gespeichert, sobald sie ankommt:

- **Am im Editor geöffneten Projekt** wird eine Änderung mit `Ctrl/Cmd + Z` rückgängig gemacht. Clients werden angewiesen, vor einer Reihe von Änderungen einen Wiederherstellungspunkt zu speichern. So kannst du sie bitten, das Projekt in einem einzigen Schritt wiederherzustellen, wie es war, und auch diesen Schritt kann `Ctrl/Cmd + Z` rückgängig machen.
- **An jedem anderen Projekt** wird eine Änderung in seiner Datei gespeichert, wo `Ctrl/Cmd + Z` sie nicht erreicht. Ein Client muss vor der ersten Änderung einen Wiederherstellungspunkt dieses Projekts speichern, und dorthin zurückzukehren ist der einzige Weg, sie rückgängig zu machen.

Wiederherstellungspunkte liegen im Speicher von OpenScreen: Sie gehen verloren, wenn OpenScreen beendet wird oder der Server neu startet, was ein Wechsel des Ports oder ein neues Token bewirkt. Nur die 20 neuesten Wiederherstellungspunkte werden behalten, ein älterer kann also früher verschwinden. Wenn du das Token mit **Regenerate** ersetzt, werden alle Clients getrennt, die mit dem alten eingerichtet wurden.

## Einen Agenten das ganze Video erstellen lassen {#letting-an-agent-make-the-whole-video}

Ein Agent kann ein ganzes Video selbstständig erstellen, von der Aufnahme bis zum Export. Neben den Bearbeitungswerkzeugen geben ihm beide Wege, OpenScreen hinzuzufügen, `listSources`, `startRecording`, `stopRecording`, `setPointerTrack`, `exportVideo`, `getFrames` und `createProject`. Eine Aufnahme kann wie mit der Aufnahmeleiste auch Ihre Webcam und den eigenen Mauszeiger des Systems aufnehmen, und ein Export übernimmt die Optionen des Export-Dialogs: Qualität und Bildrate für ein MP4; Bildrate, Größe und Wiederholung für ein GIF.

**Über den Server oben** nimmt OpenScreen eine Aufnahme selbst auf, wie mit seinem Aufnahme-Button: Der Editor schließt sich, die Aufnahmeleiste zählt herunter und nimmt auf, und die Aufnahme öffnet sich im Editor als neues Projekt, wo du jede Änderung ankommen siehst. Dafür muss **MCP-Änderungen** an sein, und die Aufnahmeleiste bekommt am Ende der Aufnahme deine eigenen Einstellungen zurück.

**Als stdio-Server** braucht es gar keine Einstellung: Der Agent startet die eigene ausführbare Datei der App mit `mcp`.

Am schnellsten fügst du Folgendes in Claude Code ein:

```text
Install the OpenScreen demo skill with `npx skills add getopenscreen/openscreen --skill openscreen-demo -a claude-code`, then follow it to make a demo video of this feature.
```

Der Skill installiert OpenScreen, falls es fehlt, sobald du zustimmst, und fügt seinen MCP-Server hinzu. Danach bittet er dich, eine neue Sitzung zu öffnen und *continue the OpenScreen demo* zu sagen: Ein Agent bekommt neue Werkzeuge nur in einer neuen Sitzung. So richtest du es stattdessen von Hand ein:

```bash
claude mcp add openscreen -- "<executable>" mcp
codex mcp add openscreen -- "<executable>" mcp
```

`<executable>` ist die ausführbare Datei der App; die jedes Systems steht unter [Die CLI ausführen](./cli.md#running-the-cli). Andere Clients, etwa Cursor, nehmen einen stdio-Server mit der ausführbaren Datei als `command` und `["mcp"]` als `args`.

- **Kein Port, kein Token, keine Einstellung.** Der Agent startet den Prozess selbst, mit deinen Rechten, so wie er `openscreen record` ausführen würde. Deshalb kann er deinen Bildschirm aufnehmen und bearbeiten, ohne den Schalter **MCP-Änderungen**.
- **Jeder Take wird zu einem neuen Projekt** in deiner Projektliste, mit Zooms auf seine Klicks, wie eine in der App gemachte Aufnahme: Zeitlich und räumlich nah beieinanderliegende Klicks teilen sich einen Zoom, und die ersten Sekunden und das Ende bleiben auf dem ganzen Bildschirm. Jede Änderung des Agenten wird in der Projektdatei gespeichert. Rückgängig macht sie der Wiederherstellungspunkt, den der Agent anlegt und der bis zum Ende seiner Sitzung besteht. Nur die 20 neuesten Wiederherstellungspunkte werden behalten, ein älterer kann also früher verschwinden.
- **Läuft OpenScreen, arbeitet der Agent über die App.** Eine Änderung am im Editor geöffneten Projekt erscheint dort sofort, und `Ctrl/Cmd + Z` macht sie rückgängig. Die Wiederherstellungspunkte des Agenten gelten dann, bis OpenScreen beendet wird. Antwortet die App nicht, werden Änderungen an diesem Projekt abgelehnt, denn der Editor würde seine eigene Kopie darüber speichern.
- **Ein Take hat kein Transkript, bis der Agent eines anfordert.** Er ruft `transcribe` auf, bevor er Wörter schneidet oder die Untertitel einschaltet. Whisper läuft auf deinem Rechner, in OpenScreen, wenn die App geöffnet ist.
- **Ein per Skript gesteuerter Take** (zum Beispiel mit Playwright) bewegt nie den Zeiger auf dem Bildschirm. Der Agent übergibt OpenScreen mit `setPointerTrack` sein eigenes Protokoll der Aktionen, und das Video bekommt trotzdem einen Cursor und dessen Zooms.
- **Der Skill `openscreen-demo`** bringt einem Agenten die ganze Arbeit bei, vom Storyboard bis zum fertigen Video. Danach hängt er das Video an einen Pull Request, damit die Reviewer die Änderung direkt dort sehen, oder entwirft einen Post auf X, den er erst veröffentlicht, wenn du Ja sagst. Füge ihn mit `npx skills add getopenscreen/openscreen --skill openscreen-demo` hinzu. Das Rezept ist [`plugin/skills/openscreen-demo/SKILL.md`](https://github.com/getopenscreen/openscreen/blob/main/plugin/skills/openscreen-demo/SKILL.md).
