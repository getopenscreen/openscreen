---
id: ai-editing
title: Montage par IA
sidebar_position: 8
description: "Monter vos projets OpenScreen par chat avec votre clé LLM. Facultatif et désactivé par défaut : rien n'est envoyé à un modèle tant qu'aucun n'est connecté."
keywords:
  - montage vidéo par IA
  - éditeur vidéo LLM
  - montage par chat
  - clé API personnelle
  - confidentialité
---

# Montage par IA

OpenScreen intègre un agent facultatif qui monte votre projet depuis un panneau de discussion. Il reste **désactivé tant que vous n'avez pas connecté vous-même un fournisseur**, et rien n'est envoyé à aucun modèle avant cela. Une fois le fournisseur connecté, l'agent ne communique qu'avec lui, tout comme la [traduction des sous-titres](./captions.md#translation). Les autres usages du réseau par l'application (téléchargement des modèles de transcription, vérification des mises à jour) sont listés dans la [FAQ](./faq.md#does-openscreen-work-offline).

:::tip
Rien de tout cela n'est obligatoire. L'enregistrement, le montage, la transcription, les sous-titres et l'export fonctionnent tous sans compte et sans fournisseur, que vous ouvriez ou non le panneau de discussion. Parmi eux, seule la transcription exige un téléchargement, une seule fois : ses [modèles](./captions.md#transcribing), lors de votre première transcription.
:::

## Connecter un fournisseur {#connecting-a-provider}

Ouvrez la colonne de discussion (le bouton tout à gauche de la barre supérieure, en mode **Édition**), puis **Paramètres IA** → choisissez un fournisseur et collez une clé API :

| Fournisseur | Remarques |
|---|---|
| **Claude API** (Anthropic) | |
| **OpenAI API** | |
| **Gemini API** (Google) | |
| **Mistral API** | |
| **OpenRouter API** | Une seule clé, de nombreux modèles. |
| **MiniMax API** / **MiniMax Token Plan** | |
| **OpenAI Compatible** | Tout point de terminaison au format OpenAI : c'est vous qui fournissez l'URL de base. |

Votre clé est stockée chiffrée grâce à la protection des identifiants de votre système d'exploitation (`safeStorage` d'Electron) ; si le chiffrement n'est pas disponible, l'enregistrement de la clé échoue au lieu de se rabattre sur du texte en clair. Les serveurs d'OpenScreen ne la voient jamais, puisqu'il n'y en a pas : les requêtes vont directement de votre machine au fournisseur choisi. Les variables d'environnement propres à chaque fournisseur fonctionnent aussi, si vous préférez ne stocker aucune clé.

:::note
Les options de connexion ChatGPT et GitHub Copilot ont été **supprimées dans la 1.8.0**. Elles reposaient sur des identifiants client propres à ces éditeurs, livrés avec l'application, qu'il ne nous appartient pas de redistribuer. Utilisez plutôt un fournisseur à clé API.
:::

## Utiliser l'agent {#using-the-agent}

Décrivez la modification en langage courant : « coupe les temps morts de l'intro », « zoome quand j'ouvre le terminal ». L'agent travaille avec de vraies opérations de timeline annulables, pas avec un nouveau rendu : il peut ajouter et ajuster des coupes, des zooms, des régions de vitesse, des annotations (texte, flèches et flous qui masquent une information privée à l'écran), des pistes audio importées avec leurs fondus, et des segments Caméra plein écran, ajouter des zooms automatiques sur vos clics, modifier les points d'entrée et de sortie et le recadrage d'un clip, placer les images d'une autre source, dupliquer, réordonner ou retirer des clips, et lire la transcription pour trouver ce dont vous parlez. Il règle aussi l'apparence de la vidéo : fond, marge, coins arrondis, ombre, cadre d'appareil, format, disposition de la caméra, curseur et volume général. Il peut aussi activer les [sous-titres](./captions.md), les styliser et les placer, et les traduire lui-même dans une autre langue. Et il peut écrire un effet visuel que les réglages n'offrent pas : voir [Effets personnalisés](./effects.md).

Le panneau qui l'entoure :

- **Conversations** : historique, renommage, suppression et création d'une nouvelle conversation. Chacune garde son propre état d'agent.
- **Sélecteur de modèle** : liste en direct des modèles du fournisseur connecté, avec un réglage de l'effort de raisonnement quand le fournisseur en propose un.
- **Jauge de contexte** : estimation des jetons utilisés par rapport au budget, avec une action **Compacter le contexte** qui résume les échanges précédents au lieu de les abandonner.
- **Revenir à ce message** : annule les modifications de l'agent et tous les échanges qui ont suivi ce point, en restaurant ensemble le projet, la conversation et l'état de l'agent.
- **Modifications par l'agent** : un interrupteur dans les **Paramètres IA**. Quand il est désactivé, chaque modification que tente l'agent est refusée : il peut toujours lire le projet et décrire le changement qu'il ferait, mais il n'applique rien tant que vous n'avez pas réactivé l'interrupteur.

`Ctrl/Cmd + Z` annule une modification de l'agent exactement comme une modification manuelle.

L'entrée **Coupes intelligentes** (marquée *Avec l'IA*) du menu Amélioration auto de la timeline est le même agent, avec une consigne unique. (L'autre entrée, **Zooms automatiques**, lit les clics enregistrés et n'a besoin d'aucun fournisseur.)

## Ce qui utilise aussi votre fournisseur {#what-else-uses-your-provider}

La [traduction des sous-titres](./captions.md#translation) est un simple appel de transformation de texte adressé au même modèle : elle ne lance pas la boucle de l'agent et ne peut pas toucher à votre document. Si vous le lui demandez dans la discussion, l'agent traduit plutôt les sous-titres lui-même, dans la même couche de traduction. La transcription et le rendu des sous-titres restent entièrement en local dans tous les cas.

## Utiliser Claude Code, Codex ou un autre client MCP {#using-claude-code-codex-or-another-mcp-client}

Si vous utilisez déjà un agent de code IA comme Claude Code ou Codex, il peut piloter les mêmes outils d'édition, connecté avec son propre compte. Rien de ce compte ne passe par OpenScreen.

1. **Paramètres IA** → **Serveur MCP** → activez-le. Il n'écoute que sur votre propre machine (`127.0.0.1`), sur le port affiché.
2. Copiez la commande **Claude Code** ou **Codex** affichée à cet endroit et lancez-la dans un terminal. La commande Claude Code contient le jeton d'accès. Codex, lui, le lit dans la variable d'environnement `OPENSCREEN_MCP_TOKEN` : définissez-la dans le shell depuis lequel vous lancez Codex.
3. Demandez la modification à votre agent, sur le projet ouvert dans l'éditeur d'OpenScreen ou sur n'importe quel autre projet de votre liste.

Les outils sont ceux qu'utilise l'agent intégré, plus ceux qui enregistrent, exportent et regardent une vidéo ([plus bas](#letting-an-agent-make-the-whole-video)). S'y ajoute `transcribe`, qui lance Whisper en local sur les médias d'un projet, comme le fait l'éditeur à l'ouverture d'un projet. Un client traduit les sous-titres avec son propre modèle : la traduction des sous-titres n'a donc besoin d'aucun fournisseur dans OpenScreen. Les outils agissent sur le projet ouvert dans l'éditeur, sauf si le client en désigne un autre : il peut lister tous les projets et lire ou modifier n'importe lequel. Il peut aussi créer un projet, vide ou à partir d'un fichier vidéo, en renommer un, et ajouter un fichier vidéo ou audio aux médias d'un projet ou en retirer un. Supprimer un projet ne fait pas partie des outils : cela reste à vous, dans l'application. Les clients MCP ne peuvent que **lire** tant que vous n'avez pas aussi activé **Modifications par MCP** dans la section Serveur MCP : jusque-là, chaque modification, enregistrement, export ou nouveau projet qu'ils tentent est refusé. Cet interrupteur est distinct de **Modifications par l'agent**, celui de l'agent intégré, et il est désactivé au départ. Une fois activé, chaque modification est enregistrée dès qu'elle est appliquée :

- **Sur le projet ouvert dans l'éditeur**, une modification s'annule avec `Ctrl/Cmd + Z`. Les clients ont pour consigne d'enregistrer un point de restauration avant une série de modifications : vous pouvez donc leur demander de remettre le projet dans son état d'avant en une seule étape, que `Ctrl/Cmd + Z` peut lui-même annuler.
- **Sur tout autre projet**, une modification est enregistrée dans son fichier, hors de portée de `Ctrl/Cmd + Z`. Un client doit enregistrer un point de restauration de ce projet avant sa première modification, et y revenir est la seule façon de l'annuler.

Les points de restauration sont gardés dans la mémoire d'OpenScreen : ils sont perdus quand il quitte ou quand le serveur redémarre, ce que provoque un changement de port ou la régénération du jeton. Seuls les 20 points de restauration les plus récents sont gardés : un plus ancien peut disparaître avant. **Régénérer** le jeton déconnecte tous les clients configurés avec l'ancien.

## Laisser un agent faire toute la vidéo {#letting-an-agent-make-the-whole-video}

Un agent peut faire une vidéo entière tout seul, de l'enregistrement à l'export. En plus des outils d'édition, les deux façons d'ajouter OpenScreen à l'agent lui donnent `listSources`, `startRecording`, `stopRecording`, `setPointerTrack`, `exportVideo`, `getFrames` et `createProject`. Une prise peut aussi enregistrer votre webcam et le curseur du système, comme la barre d'enregistrement, et un export prend les options de la boîte d'export : qualité et fréquence d'images pour un MP4 ; fréquence d'images, taille et boucle pour un GIF.

**Par le serveur ci-dessus**, une prise est enregistrée par OpenScreen lui-même, comme avec son bouton Enregistrer : l'éditeur se ferme, la barre d'enregistrement fait son décompte et enregistre, et la prise s'ouvre dans l'éditeur comme nouveau projet, où vous voyez chaque modification arriver. Il faut que **Modifications par MCP** soit activé, et la barre d'enregistrement retrouve vos propres réglages à la fin de la prise.

**Comme serveur stdio**, aucun réglage n'est nécessaire : l'agent lance l'exécutable même de l'application avec `mcp`.

Le plus rapide est de coller ceci dans votre agent IA (Claude Code, Codex, Cursor…) :

```text
Install the OpenScreen demo skill with `npx skills add getopenscreen/openscreen --skill openscreen-demo -y`, then follow it to make a demo video of this feature.
```

La skill installe OpenScreen s'il manque, une fois que vous avez accepté, et ajoute son serveur MCP. Elle vous demande ensuite d'ouvrir une nouvelle session et de dire *continue the OpenScreen demo* : un agent n'obtient de nouveaux outils que dans une nouvelle session. Pour tout configurer à la main à la place :

```bash
claude mcp add openscreen -- "<executable>" mcp
codex mcp add openscreen -- "<executable>" mcp
```

`<executable>` est l'exécutable de l'application, indiqué pour chaque système dans [Lancer la CLI](./cli.md#running-the-cli). Les autres clients, Cursor par exemple, prennent un serveur stdio avec l'exécutable pour `command` et `["mcp"]` pour `args`.

La skill existe aussi sous forme de plugin, depuis le marketplace du dépôt lui-même. Dans Claude Code :

```text
/plugin install openscreen --marketplace getopenscreen/openscreen
```

Pour Codex et l'application de bureau ChatGPT, qui partagent leurs plugins :

```bash
codex plugin marketplace add getopenscreen/openscreen
codex plugin add openscreen@openscreen
```

OpenScreen apparaît ensuite parmi les plugins installés de l'application, avec la skill.

- **Ni port, ni jeton, ni réglage.** L'agent lance lui-même le processus, avec vos droits, comme il lancerait `openscreen record`. Il peut donc enregistrer votre écran et faire des modifications sans l'interrupteur **Modifications par MCP**.
- **Chaque prise devient un nouveau projet** dans votre liste de projets, zoomé sur ses clics comme un enregistrement fait dans l'application : des clics rapprochés dans le temps et à l'écran partagent un zoom, et les premières secondes comme la fin restent sur l'écran entier. Chaque modification de l'agent est enregistrée dans le fichier du projet. Elle s'annule avec le point de restauration que prend l'agent, qui dure jusqu'à la fin de sa session. Seuls les 20 points de restauration les plus récents sont gardés : un plus ancien peut disparaître avant.
- **Quand OpenScreen est lancé, l'agent passe par l'application.** Une modification du projet ouvert dans l'éditeur y apparaît aussitôt, et `Ctrl/Cmd + Z` l'annule. Les points de restauration de l'agent durent alors jusqu'à ce que vous quittiez OpenScreen. Si l'application ne répond pas, les modifications de ce projet sont refusées, car l'éditeur enregistrerait sa propre copie par-dessus.
- **Une prise n'a pas de transcription tant que l'agent n'en demande pas.** Il appelle `transcribe` avant de couper des mots ou d'activer les sous-titres. Whisper tourne sur votre machine, dans OpenScreen quand l'application est ouverte.
- **Une prise pilotée par un script** (Playwright, par exemple) ne déplace jamais le pointeur de l'écran. L'agent transmet à OpenScreen son propre journal des actions avec `setPointerTrack`, et la vidéo a malgré tout un curseur et ses zooms.
- **La skill `openscreen-demo`** enseigne à un agent tout le travail, du storyboard jusqu'à la vidéo finie. Il joint ensuite la vidéo à une pull request, pour que les relecteurs voient le changement sur place, ou rédige un post sur X qu'il ne publie qu'une fois que vous avez dit oui. Ajoutez-la avec `npx skills add getopenscreen/openscreen --skill openscreen-demo`. La recette est [`plugin/skills/openscreen-demo/SKILL.md`](https://github.com/getopenscreen/openscreen/blob/main/plugin/skills/openscreen-demo/SKILL.md).
