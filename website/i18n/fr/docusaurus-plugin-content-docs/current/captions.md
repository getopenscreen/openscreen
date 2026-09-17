---
id: captions
title: Sous-titres et transcription
sidebar_position: 7
description: "Transcrire en local avec Whisper (100 langues), incruster des sous-titres stylisés, les traduire avec votre clé LLM, couper une vidéo en supprimant des mots."
keywords:
  - sous-titres automatiques
  - sous-titrage
  - transcription Whisper
  - transcription hors ligne
  - traduction de sous-titres
  - montage par la transcription
---

# Sous-titres et transcription

OpenScreen transcrit l'audio de votre enregistrement **entièrement en local** : votre audio n'est jamais mis en ligne, et une fois le modèle sur le disque, la transcription fonctionne hors ligne. Cette transcription unique sert ensuite de source à deux choses : les sous-titres incrustés dans votre vidéo, et une vue texte depuis laquelle vous pouvez monter votre enregistrement.

## Transcrire {#transcribing}

Chaque clip a sa propre transcription. Lancez-la de l'une ou l'autre façon :

- Depuis le mode **Médias** : sélectionnez la carte d'un média et cliquez sur **Régénérer**. C'est aussi là que vous forcez l'une des 100 langues de Whisper sous **Régénérer en**, au lieu de rester en détection **Auto**, et que s'affiche l'état de chaque média (Transcription en attente, Transcription en cours, Transcription prête, Échec de la transcription, et les autres listés dans [Médiathèque et clips](./media-library.md#media-mode)).
- Depuis l'onglet **Transcription** de l'inspecteur de l'éditeur : **Transcrire maintenant** lance le même traitement sur le média en cours.

Le moteur whisper.cpp est intégré à l'application ; le modèle ne l'est pas. La première transcription le télécharge depuis huggingface.co (~264 Mo, vérifié par SHA-256, écrit de façon atomique pour qu'un téléchargement interrompu ne puisse jamais être utilisé) : c'est le seul moment où la transcription a besoin du réseau. Ensuite, elle fonctionne entièrement hors ligne, sur un backend choisi à l'exécution : Metal sur Apple Silicon, Vulkan sous Windows et Linux avec repli sur le CPU, et le CPU sur les Mac Intel.

Le minutage des mots vient des horodatages de jetons DTW de Whisper lui-même, puis il est recalé sur l'audio : chaque limite est ramenée au moment le plus silencieux qui la précède. C'est ce qui fait tomber une coupe pilotée par la transcription là où le mot commence réellement, et non une syllabe trop tard.

## Sous-titres {#captions}

Les sous-titres sont une **vue en direct de la transcription**, et non un texte généré qu'il faudrait ensuite entretenir. Modifiez la transcription, changez les réglages des sous-titres ou déplacez des clips sur la timeline, et les sous-titres s'adaptent dès l'image suivante : aucune étape de régénération, aucune copie périmée à réconcilier.

Dans l'onglet **Transcription** de l'inspecteur, cliquez sur **Sous-titres** :

| Section | Réglages |
|---|---|
| **Afficher les sous-titres** | Activation générale, pour l'aperçu comme pour l'export. |
| **Langue** | *Original (transcription)*, ou toute couche de traduction que vous avez générée. |
| **Texte** | Police, taille, gras, couleur du texte. |
| **Fond** | Activation, couleur et opacité du bandeau derrière le texte. |
| **Position** | **Bas** ou **Haut**, avec la distance depuis ce bord (0–50 % du cadre) ; **Gauche**, **Centre** ou **Droite**, avec la distance depuis ce côté (0–25 %, aucune pour Centre). |
| **Longueur des lignes** | Nombre minimum et maximum de mots par ligne (1–12). Le texte est réparti en lignes dans cette plage. |

Tout ce qui se trouve dans **Position** se mesure par rapport au **cadre exporté**, et non à la vidéo qu'il contient. Les sous-titres restent là où vous les avez placés quand vous changez la marge, et ils peuvent se trouver dans la zone de marge : réglez la distance verticale sur 0 et le texte vient se coller au bord haut ou bas du cadre. Les sous-titres longs s'étendent à l'opposé du bord auquel ils sont ancrés : un sous-titre en bas s'étend vers le haut, un sous-titre en haut s'étend vers le bas.

La taille s'exprime en pixels pour un cadre de 1080 pixels de haut et suit la sortie réelle : les sous-titres ont donc le même aspect en 720p, en 1080p ou en source. L'aperçu et l'export partagent le même code de mise en page : ce que vous voyez est ce qui est incrusté. L'incrustation est d'ailleurs la seule forme qu'ils prennent : OpenScreen n'écrit aucun fichier `.srt` ou `.vtt` à côté de la vidéo, donc la personne qui la regarde ne peut pas les désactiver. Le [comparatif des sous-titres locaux](/features/captions/) cite des enregistreurs qui écrivent bien un fichier de sous-titres.

### Traduction {#translation}

Choisissez une langue cible et cliquez sur **Traduire**. La liste propose quinze langues cibles : anglais, français, espagnol, allemand, italien, portugais, néerlandais, polonais, turc, russe, arabe, hindi, japonais, coréen et chinois.

La traduction passe par le fournisseur de LLM que vous avez connecté (voir [Montage par IA](./ai-editing.md)) : c'est la seule fonction des sous-titres qui a besoin du réseau. Elle est stockée **à côté** de la transcription, jamais dedans : le texte d'origine et son minutage restent intacts, vous pouvez revenir à *Original* à tout moment, et supprimer une traduction laisse l'enregistrement exactement tel qu'il était. Relancer la traduction après avoir ajouté des séquences ne coûte que le nouveau contenu, et tout ce que le modèle ne renvoie pas est remplacé par les mots d'origine au lieu d'être inventé.

:::note
Les projets créés avec l'ancienne fonction « générer des sous-titres » contiennent le texte des sous-titres sous forme de vraies annotations, qui s'afficheraient par-dessus la couche en direct. Le volet Sous-titres les détecte et propose de les supprimer ; il demande d'abord, puisque cela efface des données.
:::

## Montage par la transcription {#transcript-editing}

L'onglet **Transcription** affiche la transcription agrégée de tous les clips de la timeline. C'est une vue texte en direct de votre enregistrement :

- Sélectionnez un mot ou une série de mots et appuyez sur `Backspace`/`Delete` pour marquer ce passage comme ignoré : il est retiré de la lecture et de l'export, exactement comme une région de coupe sur la timeline, mais piloté depuis le texte.
- Les passages ignorés apparaissent barrés en rouge. Survolez-en un pour le rétablir.
- Les silences sont signalés dans le texte et peuvent être coupés ou rétablis de la même façon.

Pas de mise en ligne, pas de cloud : tout cela s'appuie sur la transcription déjà présente dans votre projet.
