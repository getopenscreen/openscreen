---
id: effects
title: Effets personnalisés
description: "Demandez à un agent IA un effet visuel que les réglages n'offrent pas. Il écrit un shader GPU qu'OpenScreen dessine dans l'aperçu et dans chaque export."
keywords:
  - effets vidéo personnalisés
  - effets shader
  - WGSL
  - effets vidéo IA
  - effets GPU
---

# Effets personnalisés

Quand les réglages n'ont pas le rendu que vous cherchez, demandez-le à un agent : une onde à chaque clic, un vignettage qui respire, un fondu au noir sur les dernières secondes. L'agent écrit l'effet sous la forme d'un petit shader GPU, et OpenScreen le dessine dans l'aperçu et dans chaque export, MP4 comme GIF, sous Windows, macOS et Linux.

Les effets viennent d'un agent : le chat intégré, ou un client MCP comme Claude Code ou Codex (voir [Montage par IA](./ai-editing.md)). Une fois l'effet dans le projet, vous le réglez vous-même dans l'éditeur.

## Demander un effet {#asking-for-an-effect}

Décrivez ce que vous voulez voir, et à quel moment : « une onde à chaque clic », « un fondu au noir sur les deux dernières secondes, sous-titres compris ». L'agent écrit l'effet, le place sur la timeline, et peut regarder le résultat avec `getFrames` sans exporter la vidéo.

Un effet sait où est le curseur et où chaque clic a eu lieu, où se trouvent l'enregistrement et la webcam dans la vidéo après les zooms et la disposition, et quel est le moment. Un halo peut donc suivre la souris, et une onde partir de chaque clic, où que le zoom l'ait déplacé.

## Dans l'éditeur {#in-the-editor}

Les effets ont leur propre rangée dans la timeline, sous les passages Caméra plein écran, dès que le projet en contient un. Chaque bloc porte le nom de l'effet. Déplacez-le, redimensionnez-le, copiez-collez-le ou supprimez-le comme n'importe quelle autre région, et `Ctrl/Cmd + Z` annule la modification. Un seul effet joue à la fois : un collage sur un autre effet est refusé.

Cliquez sur un bloc pour ouvrir son inspecteur :

- **Un contrôle pour chaque réglage** que l'agent a donné à l'effet : un curseur, un interrupteur, une couleur ou un point.
- **S'applique à**, là où l'effet est dessiné :
  - **Image**, par défaut : l'enregistrement, la webcam, le curseur et le fond, sous vos annotations et vos sous-titres, qui restent lisibles.
  - **Textes** : les annotations et les sous-titres seulement.
  - **Les deux** : l'image entière, textes compris, pour un fondu au noir qui couvre aussi les sous-titres.
- **Coût** : **Léger**, **Moyen**, **Lourd** ou **Très lourd** (voir [plus bas](#cost)).
- **Code** : le shader, en lecture seule, avec **Copier le code**. Pour le modifier, demandez-le à l'agent.

Un effet copié puis collé dans un autre projet emporte son code avec lui.

## Coût {#cost}

Le coût est estimé à partir du code, en comptant combien de fois l'effet lit l'image pour chaque pixel. Le même code reçoit le même palier sur tous les ordinateurs. Rien n'est refusé pour son coût : plus l'effet est lourd, plus le passage qui lui convient est court.

| Palier | Effets typiques | Convient à |
|---|---|---|
| **Léger** | vignettage, étalonnage, onde au clic | toute la vidéo |
| **Moyen** | aberration chromatique, petit flou, glitch | quelques dizaines de secondes |
| **Lourd** | gros flou, bokeh | une transition, un temps fort |
| **Très lourd** | raymarching, simulations | quelques secondes : l'export reste exact mais plus lent, et l'aperçu peut ralentir sur un petit GPU |

## Si un effet ne compile pas {#if-an-effect-doesnt-compile}

Le code d'un agent est compilé avant que l'effet soit accepté. Un code qui échoue est refusé avec l'erreur du compilateur, et le projet ne change pas.

Un projet ouvert sur un autre ordinateur peut quand même tomber sur un compilateur qui n'est pas d'accord. L'effet n'est alors pas dessiné, son inspecteur affiche **Ne compile pas sur cet ordinateur** avec l'erreur, et l'export se poursuit sans lui.

## Les projets des autres {#projects-from-someone-else}

Un projet emporte le code de ses effets : ouvrir le projet de quelqu'un d'autre exécute donc du code que vous n'avez pas écrit. Ce code ne tourne que sur le GPU, sans accès à vos fichiers, au réseau ni à la mémoire de l'app.

## Pour les auteurs d'agents {#for-agent-authors}

Les outils sont `addEffect`, `setEffect`, `setEffectDefinition` et `getEffect`, et `removeModifier` retire un effet. Le contrat complet, c'est-à-dire la fonction `effect(uv)`, ce qu'elle peut lire et ses règles, est la ressource MCP `openscreen://effects/contract`.
