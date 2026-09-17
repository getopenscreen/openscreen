---
id: intro
title: "Documentation : installer, enregistrer, monter, exporter"
sidebar_label: Introduction
sidebar_position: 1
description: "Doc d'OpenScreen 1.11.0, enregistreur d'écran et éditeur sous licence MIT : installer, enregistrer, monter, sous-titrer, exporter (Windows, macOS, Linux)."
keywords:
  - enregistreur d'écran
  - enregistreur d'écran open source
  - enregistreur d'écran gratuit
  - éditeur vidéo
  - documentation OpenScreen
  - Windows
  - macOS
  - Linux
---

# Documentation OpenScreen : installer, enregistrer, monter, exporter

OpenScreen est un **enregistreur d'écran et éditeur gratuit et open source**. Il enregistre via l'API de capture native de chaque plateforme (ScreenCaptureKit sous macOS, Windows Graphics Capture sous Windows, PipeWire via le portail ScreenCast sous Linux), et compose l'aperçu en direct comme l'export final sur le GPU, avec un moteur de rendu natif écrit en Rust (Direct3D 11 sous Windows, Metal sous macOS, wgpu sous Linux). C'est un seul et même chemin : ce que vous voyez dans l'éditeur est ce qui sort de l'export.

Ces pages décrivent **OpenScreen 1.11.0**, la version stable du 9 septembre 2026. Ce qui a changé à chaque version, et pourquoi, se trouve dans le [journal de développement (en anglais)](/blog/).

:::note
OpenScreen sort souvent de nouvelles versions. D'une version à l'autre, le format de projet `.openscreen` et la [CLI](/docs/cli/) peuvent encore changer.
:::

## Ce que vous pouvez faire {#what-you-can-do}

- [Enregistrer](./recording.md) une fenêtre précise ou tout votre écran, avec l'audio système, le micro et la webcam, depuis un HUD flottant ou depuis l'éditeur lui-même.
- Construire un projet à partir de plusieurs sources : [importer, couper, recadrer, réordonner et diviser des clips](./media-library.md) sur une seule timeline.
- [Monter](./editing-timeline.md) avec des zooms, des coupes, une vitesse par région, des segments Caméra plein écran, des annotations texte, image, flèche et flou, des thèmes de curseur, des dispositions de webcam, ainsi que des arrière-plans et des effets.
- Transcrire en local avec Whisper, puis [incruster des sous-titres](./captions.md) (mis en forme en direct, traduisibles en 15 langues via votre propre fournisseur de LLM), ou couper votre enregistrement en supprimant des mots de la transcription.
- Connecter, si vous le souhaitez, votre propre clé LLM pour [monter par chat](./ai-editing.md). Cette fonction est désactivée par défaut et n'est jamais obligatoire.
- [Exporter](./export.md) en MP4 (720p/1080p/source, H.264 ou H.265) ou en GIF animé.

Les questions sur la licence, les filigranes ou ce qui passe par le réseau trouvent leur réponse dans la [FAQ](/docs/faq/). La comparaison d'OpenScreen avec d'autres enregistreurs se trouve sur les pages [Screen Studio](/alternatives/screen-studio/), [Cap](/compare/openscreen-vs-cap/) et [OBS Studio](/compare/openscreen-vs-obs/).

:::note
L'enregistrement, le montage, la transcription, les sous-titres et l'export ne demandent aucun compte et continuent de fonctionner sans connexion réseau. La transcription exige d'abord un téléchargement : son modèle Whisper (environ 264 Mo), récupéré lors de votre première transcription. Quand une connexion est disponible, l'application charge aussi ses polices d'annotation depuis Google Fonts au démarrage, et les versions installées depuis GitHub Releases vérifient sur GitHub la présence de mises à jour. Le montage par chat avec l'IA et la traduction des sous-titres ne passent en ligne qu'une fois que vous avez vous-même connecté un fournisseur, et seulement vers ce fournisseur.
:::

## Le projet en bref {#project-facts}

| | |
|---|---|
| **Licence** | MIT : gratuit pour un usage personnel et commercial |
| **Version documentée** | 1.11.0 ([toutes les versions](https://github.com/getopenscreen/openscreen/releases)) |
| **Plateformes** | Windows 10 version 1903 ou ultérieure (x64), macOS 13 ou ultérieur (Apple Silicon et Intel), Linux (paquets x64 ; aarch64 via le flake Nix) : voir [Installation](./installation.md) |
| **Origine** | Créé par Siddharth Vaddem, qui [a archivé le dépôt d'origine](https://github.com/siddharthvaddem/openscreen) après la v1.5.0. Le développement se poursuit ici avec son accord, sous le même nom et la même licence MIT. |

## Liens officiels {#official-links}

| | |
|---|---|
| **Site web** | [getopenscreen.com](https://getopenscreen.com/) |
| **Code source, versions, tickets** | [github.com/getopenscreen/openscreen](https://github.com/getopenscreen/openscreen) |
| **Microsoft Store** | [apps.microsoft.com/detail/9MXQ1HQJL5G5](https://apps.microsoft.com/detail/9MXQ1HQJL5G5) |
| **Discord** | [getopenscreen.com/discord](https://getopenscreen.com/discord/) |

## État de ce site {#status-of-this-site}

Tout ce qui figure sous **Fonctionnalités** dans la barre latérale documente ce qui est réellement livré dans l'application aujourd'hui, pas la feuille de route. Les spécifications internes plus détaillées dont ce site est tiré (notes d'architecture, documentation technique, plans de test) se trouvent encore dans le dépôt, en anglais, et n'ont pas encore été migrées ici :

- [`README.md`](https://github.com/getopenscreen/openscreen/blob/main/README.md)
- [`CONTRIBUTING.md`](https://github.com/getopenscreen/openscreen/blob/main/CONTRIBUTING.md)
- [`AGENTS.md`](https://github.com/getopenscreen/openscreen/blob/main/AGENTS.md)
- [`docs/`](https://github.com/getopenscreen/openscreen/tree/main/docs)
