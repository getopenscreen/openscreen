---
id: cli
title: CLI d'enregistrement d'écran pour scripts et agents
sidebar_label: CLI
description: "La CLI d'OpenScreen enregistre, sous-titre et exporte des projets .openscreen depuis des scripts, la CI et des agents de code, avec une sortie NDJSON."
keywords:
  - enregistreur d'écran en ligne de commande
  - enregistrer l'écran en ligne de commande
  - enregistreur d'écran headless
  - automatiser une vidéo de démo produit
  - NDJSON
  - openscreen export
---

# CLI d'enregistrement d'écran

L'interface en ligne de commande d'OpenScreen est intégrée à l'exécutable même de l'application de bureau. `openscreen record`, `captions`, `export`, `pack`, `info` et `sources` s'exécutent depuis un terminal sans ouvrir de fenêtre, et `--json` transforme leur sortie en NDJSON sur stdout. Un script, un job de CI ou un agent de code peut enregistrer une prise, modifier le projet `.openscreen` comme du simple JSON, et produire un MP4 ou un GIF avec le même moteur de composition natif que le bouton **Exporter** de l'éditeur.

Ce n'est pas un outil pour serveur. Chaque commande démarre Electron, qui a besoin d'un serveur d'affichage même si aucune fenêtre n'apparaît, et l'enregistrement exige une vraie session de bureau. Voir [Quand la CLI n'est pas le bon outil](#when-the-cli-is-not-the-right-tool).

:::caution
La CLI et le format de projet `.openscreen` peuvent encore changer de façon incompatible d'une version à l'autre. Vérifiez vos scripts après chaque mise à jour.
:::

## Lancer la CLI {#running-the-cli}

Commencez par [installer OpenScreen](/download/) ([Installation](./installation.md)). Chaque commande est une sous-commande de l'exécutable de l'application :

| Installation | Exécutable |
|---|---|
| macOS | `/Applications/Openscreen.app/Contents/MacOS/Openscreen` |
| Programme d'installation Windows | `Openscreen.exe` dans le dossier choisi à l'installation : `%LOCALAPPDATA%\Programs\Openscreen\` pour une installation réservée à l'utilisateur actuel, `C:\Program Files\Openscreen\` pour tous les utilisateurs |
| Linux `.deb`, `.rpm`, `.pacman` | `openscreen` |
| Linux AppImage | `./Openscreen-Linux-1.11.0.AppImage` |
| Nix | `openscreen` |

Les exemples de cette page utilisent `openscreen`. Sous macOS et Windows, utilisez le chemin complet ou un alias :

```bash
/Applications/Openscreen.app/Contents/MacOS/Openscreen export demo.openscreen -o demo.mp4
```

- `openscreen help`, `--help` ou `-h` affiche l'aide.
- Les options de Chromium placées avant la sous-commande sont sautées lors de la lecture des arguments. Si le bac à sable de Chromium ne peut pas démarrer sur la machine, lancez `./Openscreen-Linux-1.11.0.AppImage --no-sandbox export demo.openscreen`.
- Les exécutions de la CLI ne prennent pas le verrou d'instance unique de l'application : elles fonctionnent donc pendant que l'application de bureau est ouverte.
- Depuis une copie du code source, compilez l'application et ses modules natifs comme le décrit [Build and packaging (en anglais)](https://github.com/getopenscreen/openscreen/blob/main/technical-documentation/engineering/build-and-packaging.md), puis lancez `npm run cli -- <command> [options]`.

## Commandes {#commands}

### `openscreen record` {#openscreen-record}

Pour enregistrer l'écran en ligne de commande, lancez `record`. La commande utilise le même hook d'enregistrement que l'application de bureau, et les fichiers sont écrits dans le dossier des enregistrements de l'application, à côté des enregistrements faits dans l'interface graphique : la vidéo de l'écran et, quand des données de pointeur ont été capturées, un fichier de télémétrie du curseur `<video>.cursor.json`, que lisent le curseur éditable et `--auto-zoom`.

```bash
openscreen record --duration 30 --project demo.openscreen --json
openscreen record --window "My App" --mic --system-audio
openscreen record --display 1 --cursor system
```

| Option | Signification |
|---|---|
| `--display <n>` | Index de l'écran, tel que listé par `openscreen sources` (0 par défaut) |
| `--window <title>` | Enregistre la première fenêtre dont le titre contient `<title>`, sans tenir compte de la casse. Prioritaire sur `--display` |
| `--mic` | Capture le microphone par défaut |
| `--mic-device <name>` | Capture le microphone dont le nom contient `<name>`, sans tenir compte de la casse. Implique `--mic` |
| `--system-audio` | Capture l'audio système |
| `--cursor <editable-overlay\|system>` | `editable-overlay` (par défaut) masque le pointeur du système et l'enregistre sous forme de données, pour que l'éditeur puisse en changer le style. `system` dessine le pointeur dans la vidéo |
| `--duration <seconds>` | S'arrête automatiquement après cette durée |
| `--project <out.openscreen>` | À la fin, écrit un fichier de projet qui référence l'enregistrement, prêt pour `export` ou pour l'éditeur. Doit se terminer par `.openscreen` |
| `--json` | Événements NDJSON sur stdout |

Il n'y a pas d'option webcam : un enregistrement fait avec la CLI ne contient que l'écran et l'audio.

**Arrêter.** Sans `--duration`, arrêtez un enregistrement avec Ctrl+C (SIGINT), SIGTERM, ou en tapant `stop`, `q` ou `quit` puis Entrée sur son stdin. Fermer stdin ne l'arrête pas. Un arrêt forcé court-circuite la fin normale : ni événement `done` ni fichier de projet ne sont alors écrits.

**Selon la plateforme**

- **macOS.** La capture passe par le module ScreenCaptureKit, sans repli. L'autorisation Enregistrement de l'écran est requise ; pour une version de développement lancée depuis un terminal, accordez-la au terminal. Avec `--mic`, la CLI demande l'accès au micro s'il n'a pas été accordé. Les clics et les formes du pointeur ne sont enregistrés qu'avec l'autorisation Accessibilité.
- **Windows.** La capture passe par le module Windows Graphics Capture, à partir de la build 19041 de Windows 10. Sur les builds antérieures, ou sans le module, OpenScreen se rabat sur la capture par le navigateur. Windows n'envoie jamais SIGTERM : utilisez Ctrl+C, `stop` sur stdin, ou `--duration`.
- **Linux.** La capture passe par le module PipeWire et le portail ScreenCast du bureau. C'est le sélecteur du portail qui décide de ce qui est enregistré ; il s'ouvre à chaque exécution et attend une réponse : `--display` et `--window` ne choisissent donc pas la source, et un enregistrement sous Linux ne peut pas démarrer sans intervention. Il faut une session de bureau avec `xdg-desktop-portal` : une session SSH sans affichage ne peut pas enregistrer. Seule une version sans le module se rabat sur la capture de Chromium.

### `openscreen sources` {#openscreen-sources}

Liste les écrans, fenêtres et microphones que voit l'application, pour qu'un script puisse choisir les valeurs de `--display`, `--window` et `--mic-device`. Sous Linux, c'est toujours le sélecteur du portail qui décide de ce que `record` capture.

```bash
openscreen sources                   # human-readable
openscreen sources --json            # NDJSON on stdout
openscreen sources -o sources.json   # payload written to a file
```

Avec `--json`, les données arrivent dans l'événement `done` final :

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

`microphoneLabelsUnavailable` vaut `true` quand les noms des périphériques exigent une autorisation qui n'a pas été accordée, ou quand la liste des périphériques n'a pas pu être lue en quelques secondes.

**Pourquoi `-o` existe.** La CLI n'écrit que sa propre sortie sur stdout ; les diagnostics de Chromium vont sur stderr. Le programme qui enveloppe le processus, lui, est une autre affaire. `xvfb-run` d'Ubuntu, la façon habituelle de lancer un binaire graphique sur une machine sans écran, fusionne stderr dans stdout : les avertissements de démarrage de Chromium arrivent alors avant le JSON, et `openscreen sources --json | jq` échoue. `-o <file>` écrit à un endroit qu'aucun programme enveloppant ne peut rediriger, et évite les différences de guillemets et d'encodage entre shells.

Les deux canaux ne présentent pas les données sous la même forme. stdout enveloppe les données dans l'événement `done`, parce que c'est un événement dans un flux. Le fichier contient les données seules :

```bash
openscreen sources --json | jq 'select(.event == "done") | .sources.displays'   # stdout: inside the envelope
openscreen sources -o s.json && jq '.displays' s.json                             # file: the payload itself
```

Le fichier n'est écrit qu'en cas de succès, et de façon atomique : une exécution en échec laisse intact un fichier existant. Vérifiez le code de sortie, pas l'existence du fichier.

### `openscreen export` {#openscreen-export}

Produit le rendu d'un projet en MP4 ou en GIF avec le moteur de composition natif qu'utilise l'éditeur pour son aperçu et son export. Les zooms, coupes, régions de vitesse, annotations et sous-titres, le curseur et l'arrière-plan viennent tous du projet.

```bash
openscreen export demo.openscreen                          # format and quality from the project
openscreen export demo.openscreen -o out.mp4 --quality source
openscreen export demo.openscreen -o out.gif --gif-fps 20 --gif-size large
openscreen export demo.openscreen -o out.mp4 --auto-zoom --json
```

| Option | Signification |
|---|---|
| `-o, --out <path>` | Fichier de sortie. L'extension, `.mp4` ou `.gif`, détermine le format. Par défaut : le chemin du projet avec `.mp4` ou `.gif` |
| `--format <mp4\|gif>` | Remplace le format enregistré dans le projet. Doit concorder avec `--out` |
| `--quality <medium\|good\|source>` | Taille de sortie : `medium` correspond à 720p, `good` à 1080p, et `source` suit le plus petit clip après recadrage, donc n'agrandit jamais. Un GIF part lui aussi de cette taille |
| `--gif-fps <15\|20\|25\|30>` | Fréquence d'images du GIF |
| `--gif-size <medium\|large\|original>` | Hauteur maximale du GIF, appliquée à cette taille : 720, 1080, ou aucune |
| `--auto-zoom` | Avant le rendu, ajoute des zooms là où le pointeur enregistré s'est arrêté, avec le même moteur que les [zooms automatiques](/features/auto-zoom/) de l'éditeur. Les zooms existants sont conservés, et les nouveaux ne les chevauchent jamais |
| `--audio <file>` | Mixe un fichier de voix off (mp3, wav ou m4a) dans le MP4. MP4 uniquement |
| `--audio-mode <mix\|replace>` | `mix` (par défaut) garde l'audio de l'enregistrement sous la voix off, avec un gain de 40 % ; `replace` le supprime |
| `--audio-offset <seconds>` | Délai avant le début de la voix off (0 par défaut) |
| `--json` | Progression et résultat en NDJSON sur stdout |

Les exports MP4 de la CLI sont toujours en **H.264 à 60 fps**. Il n'y a pas d'option de codec ni de fréquence d'images. La fenêtre [Export](./export.md) de l'application de bureau propose en plus H.265 et 24 ou 30 fps.

`--audio` intervient après le rendu : le flux vidéo est copié sans modification, et une nouvelle piste AAC est mixée puis écrite par-dessus le même fichier de sortie.

**Où peuvent se trouver les médias.** Quand elle charge un projet, l'application n'approuve automatiquement les médias référencés que s'ils se trouvent dans son dossier d'enregistrements ou dans le dossier du fichier de projet. Gardez un projet écrit à la main à côté de ses médias, ou enregistrez avec la CLI, qui utilise le dossier des enregistrements.

**Pas d'annulation.** Seule la commande `record` écoute une demande d'arrêt. Terminer le processus est le seul moyen d'abandonner un export ; considérez comme inutilisable tout ce qu'il a laissé au chemin de sortie.

### `openscreen captions` {#openscreen-captions}

Transcrit l'audio du projet sur votre machine avec Whisper, puis écrit des annotations de sous-titres dans le fichier de projet. Rien n'est mis en ligne, et la langue est détectée automatiquement. La première exécution télécharge le modèle Whisper une seule fois, environ 264 Mo, comme le fait l'application de bureau.

```bash
openscreen captions demo.openscreen --min-words 2 --max-words 7
openscreen export demo.openscreen -o demo.mp4   # captions are burned into the video
```

- `--min-words` et `--max-words` fixent le nombre de mots par sous-titre. Par défaut : 2 et 7.
- La relancer remplace les sous-titres qu'elle avait ajoutés. Les annotations que vous avez ajoutées vous-même sont conservées.
- La vidéo d'écran du projet doit avoir une piste audio, par exemple issue de `record --mic`.
- Les sous-titres sont incrustés dans l'export. Aucun fichier de sous-titres n'est produit. Voir [Sous-titres et transcription](./captions.md).

### `openscreen pack` {#openscreen-pack}

Copie un projet et tout ce qu'il référence (vidéo d'écran, vidéo de la webcam, télémétrie du curseur) dans un seul dossier, et réécrit les chemins des médias dans le projet copié.

```bash
openscreen pack demo.openscreen --out bundle/
```

`-o` est accepté comme forme courte de `--out`, qui est obligatoire. Le dossier peut être déplacé ou conservé comme artefact de CI : quand les chemins absolus enregistrés n'existent plus, l'application se rabat sur les fichiers de même nom situés à côté du fichier de projet.

### `openscreen info` {#openscreen-info}

Affiche ce qu'un projet référence et si sa vidéo d'écran existe toujours, ainsi que ses réglages d'export et le nombre de zooms, coupes, régions de vitesse et annotations qu'il contient.

```bash
openscreen info demo.openscreen --json
```

La commande se termine avec le code 1 quand la vidéo d'écran référencée est manquante.

## Sortie lisible par une machine {#machine-readable-output}

Avec `--json`, stdout transporte un objet JSON par ligne. stderr ne transporte que des diagnostics, y compris les lignes de journal de l'application elle-même.

```json
{"event":"started","command":"export"}
{"event":"progress","percentage":50,"currentFrame":60,"totalFrames":120,"estimatedTimeRemaining":3}
{"event":"done","success":true,"outputPath":"/path/out.mp4","format":"mp4","width":1920,"height":1080}
```

| Événement | Envoyé quand | Champs |
|---|---|---|
| `started` | Une exécution de `record`, `sources`, `export` ou `captions` commence | `command` |
| `log` | Une ligne d'état, comme `Recording started` | `message` |
| `progress` | Des images d'export sont encodées | `percentage`, `currentFrame`, `totalFrames`, `estimatedTimeRemaining` en secondes. Pendant le mixage de `--audio` : `percentage` et `phase: "mixing-voiceover"` |
| `stopping` | `record` a reçu une demande d'arrêt | `reason` : `SIGINT`, `SIGTERM` ou `stdin` |
| `warning` | L'exécution a réussi, avec une réserve | `message` |
| `error` | Un échec a été signalé | `message` |
| `done` | L'exécution est terminée, avec ou sans succès | `success`, puis le résultat, ou `error` |

Ce que contient `done` :

- **export :** `outputPath`, `format`, `width`, `height`.
- **record :** `screenVideoPath`, `cursorDataPath` (l'emplacement prévu du fichier de télémétrie ; il peut ne pas exister), `durationMs` ; avec `--project`, aussi `projectPath` et `projectData`, le projet écrit.
- **sources :** `sources`.
- **captions :** `projectPath`, `captionCount`.
- **pack :** `projectPath`, `files`, `cursorData`. `pack` n'envoie pas d'événement `started`.

`info --json` affiche un unique objet de synthèse, sans champ `event`.

Un `pack` ou un `info` qui échoue se termine par un événement `error`, sans `done`. Un plantage peut se terminer par un événement `error`, ou sans plus rien sur stdout. Fiez-vous au code de sortie.

**Codes de sortie**

| Code | Signification |
|---|---|
| `0` | Succès |
| `1` | Échec, y compris `info` sur un projet dont la vidéo d'écran est manquante |
| `2` | Arguments invalides. Le message et l'aide vont sur stderr en texte brut, même avec `--json` |

## Exemple : une démo produit automatisée {#example-an-automated-product-demo}

Un script ou un agent de code peut produire une démo sous-titrée et zoomée sans ouvrir l'éditeur :

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

À l'étape 3, `depth` va de 1 à 6 (de 1.25× à 5× ; 3 correspond à 1.8×), et `cx` et `cy` placent le centre du zoom en fractions du cadre.

Pour une narration en synthèse vocale à la place, enregistrez sans `--mic` et mixez la voix off à l'export. Tout moteur qui écrit du mp3, du wav ou du m4a convient ; l'exemple utilise `say` de macOS :

```bash
say -o voice.m4a --file-format=m4af "Welcome to MyProduct. Here is a quick tour."
openscreen export demo.openscreen -o demo.mp4 --auto-zoom --audio voice.m4a --audio-mode replace
```

`captions` lit la piste audio propre à l'enregistrement, pas une voix off mixée à l'export : une narration en synthèse vocale n'obtient donc pas de sous-titres de cette façon.

**Exporter une vidéo venant d'un autre outil.** `export` n'a pas besoin d'un enregistrement OpenScreen. Le plus petit projet qu'elle accepte se compose d'un chemin de média et d'un éditeur vide, qui devient un clip unique couvrant toute la vidéo, avec les réglages par défaut :

```json
{
  "version": 2,
  "media": { "screenVideoPath": "/path/to/clip.mp4" },
  "editor": {}
}
```

Enregistrez-le dans le même dossier que le clip. Sans télémétrie du curseur, `--auto-zoom` n'a rien sur quoi s'appuyer.

## Affichage, CI et serveurs {#displays-ci-and-servers}

- Chaque commande démarre Electron, qui démarre Chromium : un serveur d'affichage doit donc être présent, même si aucune fenêtre ne s'ouvre. Sur une machine Linux sans écran, un serveur X virtuel lancé avec `xvfb-run` le fournit.
- `export` ne capture rien : la commande fonctionne donc ainsi, pourvu qu'un pilote Vulkan soit disponible : le moteur de composition Linux fait son rendu via Vulkan, et une machine sans GPU a besoin d'un pilote logiciel comme lavapipe de Mesa. Le workflow de build Nix du projet produit ainsi un MP4 à partir d'un clip généré, sous `xvfb-run` avec lavapipe, sur un runner Linux sans écran, et échoue si aucun MP4 n'en sort.
- `record`, non. Sur ce même runner, Chromium ne trouve aucun écran à capturer, et sous Linux le sélecteur du portail exige de toute façon une personne.

## Quand la CLI n'est pas le bon outil {#when-the-cli-is-not-the-right-tool}

- **Vous devez enregistrer sur un serveur** sans affichage ni session de bureau. L'enregistrement exige un vrai bureau, et sous Linux quelqu'un doit répondre au sélecteur du portail à chaque exécution.
- **Vous avez besoin d'une API stable et versionnée.** La CLI et le format de projet peuvent encore changer d'une version à l'autre.
- **Vous voulez régler le codec, la fréquence d'images ou le débit en ligne de commande.** Les exports MP4 de la CLI sont en H.264 à 60 fps, et le débit MP4 n'est pas réglable non plus dans l'application.
- **Vous avez besoin de la webcam dans un enregistrement scripté.** `record` n'a pas d'option caméra.
- **Vous avez besoin de fichiers de sous-titres.** Les sous-titres sont uniquement incrustés dans la vidéo.

Pour une mise en pratique des mêmes étapes dans l'éditeur, voir [Comment faire une vidéo de démo produit](./guides/product-demo-video.md). Les réponses sur la licence et l'usage du réseau se trouvent dans la [FAQ](./faq.md).

## Code source {#source-code}

La CLI fait partie du [dépôt OpenScreen](https://github.com/getopenscreen/openscreen) :

- `electron/cli/args.ts` : l'analyseur d'arguments et le texte d'aide, couverts par des tests unitaires dans `args.test.ts`.
- `electron/cli/cliMain.ts` : le démarrage sans fenêtre, le protocole stdio, les signaux d'arrêt et les codes de sortie.
- `electron/cli/projectCommands.ts` : `pack` et `info`.
- `src/cli/` : les exécuteurs en fenêtre cachée de `record`, `sources`, `export` et `captions`.
- `src/lib/cliContracts.ts` : les types de requête et de résultat partagés par les deux côtés.
