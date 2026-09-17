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

L'entrée **Coupes intelligentes** (marquée *Avec l'IA*) du menu Amélioration auto de la timeline est le même agent, avec une consigne unique. (L'autre entrée, **Zooms automatiques**, lit le mouvement enregistré du curseur et n'a besoin d'aucun fournisseur.)

## Ce qui utilise aussi votre fournisseur {#what-else-uses-your-provider}

La [traduction des sous-titres](./captions.md#translation) est un simple appel de transformation de texte adressé au même modèle : elle ne lance pas la boucle de l'agent et ne peut pas toucher à votre document. La transcription et le rendu des sous-titres restent entièrement en local dans tous les cas.
