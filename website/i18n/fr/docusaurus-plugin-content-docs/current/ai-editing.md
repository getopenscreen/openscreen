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

OpenScreen intègre un agent facultatif qui monte votre projet depuis un panneau de discussion. Il reste **désactivé tant que vous n'avez pas connecté vous-même un fournisseur**, et rien n'est envoyé à aucun modèle avant cela. Une fois le fournisseur connecté, l'agent ne communique qu'avec lui, tout comme la [traduction des sous-titres](./captions.md#translation). Les autres usages du réseau par l'application (téléchargement du modèle Whisper, polices d'annotation, vérification des mises à jour) sont listés dans l'[introduction](./intro.md).

:::tip
Rien de tout cela n'est obligatoire. L'enregistrement, le montage, la transcription, les sous-titres et l'export fonctionnent tous sans compte et sans fournisseur, que vous ouvriez ou non le panneau de discussion. Parmi eux, seule la transcription exige un téléchargement, une seule fois : le [modèle Whisper](./captions.md#transcribing), lors de votre première transcription.
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

Décrivez la modification en langage courant : « coupe les temps morts de l'intro », « zoome quand j'ouvre le terminal ». L'agent travaille avec de vraies opérations de timeline annulables, pas avec un nouveau rendu : il peut ajouter et ajuster des coupes, des zooms, des régions de vitesse, des annotations et des segments Caméra plein écran, modifier les points d'entrée et de sortie des clips, réordonner ou retirer des clips, et lire la transcription pour trouver ce dont vous parlez.

Le panneau qui l'entoure :

- **Conversations** : historique, renommage, suppression et création d'une nouvelle conversation. Chacune garde son propre état d'agent.
- **Sélecteur de modèle** : liste en direct des modèles du fournisseur connecté, avec un réglage de l'effort de raisonnement quand le fournisseur en propose un.
- **Jauge de contexte** : estimation des jetons utilisés par rapport au budget, avec une action **Compacter le contexte** qui résume les échanges précédents au lieu de les abandonner.
- **Revenir à ce message** : annule les modifications de l'agent et tous les échanges qui ont suivi ce point, en restaurant ensemble le projet, la conversation et l'état de l'agent.
- **Modifications du projet** : un interrupteur dans les **Paramètres IA**. Quand il est désactivé, chaque modification que tente l'agent est refusée : il peut toujours lire le projet et décrire le changement qu'il ferait, mais il n'applique rien tant que vous n'avez pas réactivé l'interrupteur.

`Ctrl/Cmd + Z` annule une modification de l'agent exactement comme une modification manuelle.

L'entrée **Coupes intelligentes** (marquée *Avec l'IA*) du menu Amélioration auto de la timeline est le même agent, avec une consigne unique. (L'autre entrée, **Zooms automatiques**, lit les clics enregistrés et n'a besoin d'aucun fournisseur.)

## Ce qui utilise aussi votre fournisseur {#what-else-uses-your-provider}

La [traduction des sous-titres](./captions.md#translation) est un simple appel de transformation de texte adressé au même modèle : elle ne lance pas la boucle de l'agent et ne peut pas toucher à votre document. La transcription et le rendu des sous-titres restent entièrement en local dans tous les cas.

## Utiliser Claude Code, Codex ou un autre client MCP {#using-claude-code-codex-or-another-mcp-client}

Si vous utilisez déjà un agent de code IA comme Claude Code ou Codex, il peut piloter les mêmes outils d'édition, connecté avec son propre compte. Rien de ce compte ne passe par OpenScreen.

1. **Paramètres IA** → **Serveur MCP** → activez-le. Il n'écoute que sur votre propre machine (`127.0.0.1`), sur le port affiché.
2. Copiez la commande **Claude Code** ou **Codex** affichée à cet endroit et lancez-la dans un terminal. La commande Claude Code contient le jeton d'accès. Codex, lui, le lit dans la variable d'environnement `OPENSCREEN_MCP_TOKEN` : définissez-la dans le shell depuis lequel vous lancez Codex.
3. Gardez un projet ouvert dans l'éditeur d'OpenScreen, puis demandez la modification à votre agent.

Les outils sont ceux qu'utilise l'agent intégré, et ils agissent sur le projet ouvert dans l'éditeur. Les clients MCP ne peuvent que **lire** le projet tant que vous n'avez pas aussi activé **Modifications du projet** dans la section Serveur MCP ; cet interrupteur est distinct de celui de l'agent intégré, et il est désactivé au départ. Une fois activé, chaque modification est enregistrée dès qu'elle est appliquée et s'annule avec `Ctrl/Cmd + Z`. Les clients ont pour consigne d'enregistrer un point de restauration avant une série de modifications : vous pouvez donc leur demander de remettre le projet dans son état d'avant en une seule étape, que `Ctrl/Cmd + Z` peut lui-même annuler. **Régénérer** le jeton déconnecte tous les clients configurés avec l'ancien.

## Laisser un agent faire toute la vidéo {#letting-an-agent-make-the-whole-video}

Le serveur ci-dessus modifie des projets. Pour qu'un agent fasse une vidéo entière tout seul, de l'enregistrement à l'export, ajoutez plutôt OpenScreen à l'agent comme serveur stdio : l'agent lance l'exécutable même de l'application avec `mcp`. Il dispose des mêmes outils d'édition, plus `listSources`, `startRecording`, `stopRecording`, `setPointerTrack`, `exportVideo` et `getFrames`.

Le plus rapide est de coller ceci dans Claude Code :

```text
Install the OpenScreen demo skill with `npx skills add getopenscreen/openscreen --skill openscreen-demo -a claude-code`, then follow it to make a demo video of this feature.
```

La skill installe OpenScreen s'il manque, une fois que vous avez accepté, et ajoute son serveur MCP. Elle vous demande ensuite d'ouvrir une nouvelle session et de dire *continue the OpenScreen demo* : un agent n'obtient de nouveaux outils que dans une nouvelle session. Pour tout configurer à la main à la place :

```bash
claude mcp add openscreen -- "/Applications/Openscreen.app/Contents/MacOS/Openscreen" mcp
codex mcp add openscreen -- "/Applications/Openscreen.app/Contents/MacOS/Openscreen" mcp
```

L'exécutable de chaque système est indiqué dans [Lancer la CLI](./cli.md#running-the-cli).

- **Ni port, ni jeton, ni réglage.** L'agent lance lui-même le processus, avec vos droits, comme il lancerait `openscreen record`. Il peut donc enregistrer votre écran et faire des modifications sans l'interrupteur **Modifications du projet**.
- **Chaque prise devient un nouveau projet** dans votre liste de projets, zoomé sur ses clics comme un enregistrement fait dans l'application : des clics rapprochés partagent un zoom, et les premières secondes comme la fin restent sur l'écran entier. Ne le modifiez pas dans l'éditeur tant que l'agent y travaille encore : l'éditeur garde sa propre copie.
- **Une prise pilotée par un script** (Playwright, par exemple) ne déplace jamais le pointeur de l'écran. L'agent transmet à OpenScreen son propre journal des actions avec `setPointerTrack`, et la vidéo a malgré tout un curseur et ses zooms.
- **La skill `openscreen-demo`** enseigne à un agent tout le travail, du storyboard jusqu'à la vidéo finie. Il joint ensuite la vidéo à une pull request, pour que les relecteurs voient le changement sur place, ou rédige un post sur X qu'il ne publie qu'une fois que vous avez dit oui. Ajoutez-la avec `npx skills add getopenscreen/openscreen --skill openscreen-demo`. La recette est [`skills/openscreen-demo/SKILL.md`](https://github.com/getopenscreen/openscreen/blob/main/skills/openscreen-demo/SKILL.md).
