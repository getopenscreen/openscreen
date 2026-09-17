---
id: media-library
title: Médiathèque et clips
sidebar_position: 5
description: "Gérer sources et clips dans OpenScreen : importer des vidéos, couper, recadrer, diviser et réordonner les clips sur une timeline, régler la taille de sortie."
keywords:
  - médiathèque
  - clips vidéo
  - couper une vidéo
  - recadrer une vidéo
  - diviser un clip
  - timeline
---

# Médiathèque et clips

Un projet n'est pas un enregistrement unique : c'est un ensemble de sources et une liste ordonnée de clips découpés dans ces sources. Le mode **Médias** sert à gérer les sources ; la rangée de clips, en bas de la timeline, sert à les organiser.

## Mode Médias {#media-mode}

Choisissez **Médias** dans la barre supérieure. La zone principale affiche une carte par source du projet, avec un champ de recherche au-dessus.

Sélectionnez une carte pour ouvrir son panneau de détails :

- **Transcription de la source** : le texte complet de ce média, avec son état (Aucune transcription / Transcription en attente / Téléchargement du modèle vocal / Démarrage du modèle vocal / Transcription en cours / Transcription prête / Aucune parole détectée / Aucune piste audio / Échec de la transcription) et la langue détectée.
- **Régénérer en** : relance Whisper en local pour ce média, soit en détection **Auto**, soit en forçant l'une des 100 langues prises en charge par Whisper.

**Importer un média** ajoute une vidéo depuis le disque. La boîte de dialogue accepte `webm`, `mp4`, `mov`, `avi`, `mkv`, `m4v`, `wmv`, `flv` et `ts`. Cette zone ne contient que des vidéos : la musique et les autres fichiers audio s'ajoutent depuis le menu **Ajouter un audio** de la barre d'outils de la timeline, et les images s'ajoutent comme [annotations image](./editing-timeline.md#annotations).

Importer une source ne la place *pas* sur la timeline. Pour cela, faites glisser sa carte sur la rangée de clips.

## Clips sur la timeline {#clips-on-the-timeline}

La rangée du bas de la timeline est la bande des clips. Chaque clip affiche sa propre forme d'onde.

- **Glissez pour réordonner.** Les régions posées au-dessus suivent leur clip : un zoom placé sur un clip reste sur ce clip quand celui-ci bouge.
- **Double-cliquez** (ou utilisez le crayon d'un clip) pour ouvrir **Modifier le clip** : points d'entrée et de sortie avec une plage que l'on peut parcourir, et un rectangle de recadrage avec des poignées déplaçables, des valeurs X/Y/L/H numériques et des préréglages de proportions. Le recadrage se règle clip par clip.
- **Supprimer le clip** le retire de la timeline ; la source reste dans la médiathèque.
- **Déposez une source sur un clip existant** et OpenScreen demande où la placer : **Ajouter avant**, **Ajouter après** ou **Diviser ici et insérer**, qui coupe le clip cible au point de dépôt et insère la nouvelle source entre les deux morceaux.

Les clips sont toujours contigus : ni trous, ni chevauchements. Si vous en supprimez ou en déplacez un, la suite de la timeline se resserre pour combler le vide.

## Taille de sortie {#output-size}

Le réglage **Format** de l'onglet **Composition** définit la forme du cadre ; **Original** liste les formes réelles des clips de votre projet. Chaque clip est ajusté dans ce cadre : vous pouvez donc mélanger un enregistrement d'écran 16:9 et une capture de téléphone 9:16 dans une même timeline. Voir [Export](./export.md#resolution) pour la résolution obtenue.

## Démarrer un projet {#starting-a-project}

**Nouveau projet** demande un nom et un point de départ :

- **Enregistrement d'écran** : ouvre directement le [mode Enregistrement](./recording.md#recording-from-the-editor-rec-mode).
- **Importer un média** : ouvre le sélecteur de fichiers.

**Ouvrir un projet** liste vos fichiers `.openscreen` récents avec un champ de recherche, la navigation au clavier et un bouton **Parcourir les fichiers…** pour chercher ailleurs. Vous pouvez aussi déposer un fichier `.openscreen` sur l'éditeur vide.
