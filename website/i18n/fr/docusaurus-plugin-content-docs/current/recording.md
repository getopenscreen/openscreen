---
id: recording
title: Enregistrement d'écran
sidebar_position: 4
sidebar_label: Enregistrement
description: "Enregistrer une fenêtre ou tout l'écran avec le HUD d'OpenScreen : audio système, micro, webcam, modes du curseur, compte à rebours, capture native."
keywords:
  - enregistrer son écran
  - capture de fenêtre
  - enregistrer l'audio système
  - enregistrement webcam
  - ScreenCaptureKit
  - Windows Graphics Capture
  - PipeWire
---

# Enregistrement d'écran

L'enregistrement passe par le **HUD**, une pastille superposée, déplaçable et toujours au premier plan. Elle ignore les clics de souris partout sauf sur ses propres commandes : elle ne gêne donc jamais l'application que vous enregistrez.

## Choisir une source {#choosing-a-source}

Le bouton du sélecteur de source affiche le nom, tronqué, de l'écran ou de la fenêtre sélectionnés, et se désactive dès que l'enregistrement démarre. Un clic dessus ouvre une fenêtre séparée avec deux onglets :

- **Écrans** : une carte par écran.
- **Fenêtres** : une carte par fenêtre ouverte, avec l'icône de son application.

Choisissez une vignette et cliquez sur **Partager**. Si aucune source n'est choisie quand vous lancez l'enregistrement, OpenScreen ouvre d'abord le sélecteur et démarre l'enregistrement automatiquement dès que vous en choisissez une.

Il n'y a pas de capture de zone : vous enregistrez un écran entier ou une fenêtre, puis vous recadrez l'image après coup, clip par clip, dans l'éditeur.

Sous Linux, le HUD n'affiche aucun sélecteur de source, seulement *Le système vous demandera quoi partager*. Ce choix revient au portail ScreenCast : lancer l'enregistrement ouvre la boîte de dialogue de partage de votre bureau avant le compte à rebours, et celle-ci repose la question à chaque prise.

## Audio {#audio}

Trois interrupteurs se trouvent dans un même groupe de commandes :

- **Audio système** : capture ce qui est lu sur la machine. Ne peut plus être modifié une fois l'enregistrement lancé.
- **Microphone** : l'activer (hors enregistrement) ouvre une fenêtre contextuelle avec un vumètre en direct à 5 barres et une liste déroulante de tous les périphériques d'entrée disponibles, pour vérifier que c'est le bon micro avant de commencer.
- **Webcam** : l'activer affiche un sélecteur de caméra avec les états attendus (recherche, indisponible, aucune caméra trouvée). La webcam est enregistrée sur sa propre piste, puis intégrée à la composition dans l'éditeur.

La prise en charge de l'audio système dépend de votre système d'exploitation : voir les [différences entre plateformes](./installation.md#platform-differences).

## Mode du curseur {#cursor-mode}

Sous Windows, macOS et Linux, un bouton de mode du curseur bascule entre :
- **Curseur éditable** (par défaut) : le curseur du système n'est pas incrusté dans l'image et son mouvement est enregistré sous forme de données, ce qui permet à OpenScreen de dessiner un curseur dont vous choisissez le thème, la taille et l'animation dans l'éditeur.
- **Curseur système** : enregistre le curseur du système tel quel, sans modification.

Ce que capture le curseur éditable dépend de la plateforme :
- **Windows** : la vraie forme du curseur et les clics.
- **macOS** : la forme du curseur et les clics, qui exigent l'autorisation Accessibilité. Dans ce mode, sans cette autorisation, le bouton d'enregistrement ouvre une invite qui renvoie vers le réglage au lieu de lancer l'enregistrement (voir l'[installation sous macOS](./installation.md#macos)).
- **Linux** : la position et la forme via le portail ScreenCast, ainsi que les clics gauches si votre utilisateur fait partie du groupe `input` (voir [Clics de souris sous Wayland](./installation.md#mouse-clicks-on-wayland)).

Une prise sous Linux qui se rabat sur la [capture par le navigateur](#native-vs-browser-capture) enregistre le curseur du système, quel que soit le mode choisi.

## Commandes d'enregistrement {#recording-controls}

- **Enregistrer / Arrêter** : une pastille qui affiche le nom de la source au survol hors enregistrement, et un chronomètre `mm:ss` en direct pendant l'enregistrement (le fond devient ambre en pause).
- **Mettre en pause / Reprendre** : disponible en cours d'enregistrement.
- **Redémarrer** : abandonne la prise en cours et repart de zéro.
- **Annuler** : abandonne la prise en cours sans la sauvegarder.
- **Ouvrir le Studio** : bascule vers l'éditeur (masqué pendant l'enregistrement).

## Compte à rebours {#countdown}

Lancer l'enregistrement déclenche un compte à rebours 3‑2‑1, affiché en superposition sur tout le bureau, avant que la capture ne commence réellement.

## Autres commandes du HUD {#other-hud-controls}

- **Bouton de disposition** : fait passer le HUD de l'horizontale à la verticale, et inversement ; ce choix est conservé d'une session à l'autre.
- **Paramètres des périphériques** : les réglages du micro et de la caméra sélectionnés, sans quitter le HUD.
- **Notes** (sauf sous Linux) : ouvre une petite fenêtre de texte enrichi qui sert de bloc-notes, pratique pour un script ou un aide-mémoire pendant l'enregistrement. Son contenu est conservé localement d'une session à l'autre.
- **Langue** : un sélecteur de langue (13 langues) qui ne concerne que l'interface d'OpenScreen, pas votre enregistrement.
- Des commandes de fenêtre pour masquer le HUD ou quitter l'application.

## Enregistrer depuis l'éditeur (mode Enregistrement) {#recording-from-the-editor-rec-mode}

Vous n'êtes pas obligé de partir du HUD. Dans l'éditeur, choisissez **Enregistrement** dans la barre supérieure pour obtenir une page de préparation en pleine taille au lieu d'une pastille :

- **Source** : le même sélecteur d'écran ou de fenêtre, dans une fenêtre modale. Sous Linux, cette ligne affiche aussi *Le système vous demandera quoi partager*, et c'est la boîte de dialogue du portail qui fait le choix.
- **Audio système**, **Microphone**, **Caméra** : chacun sur une ligne avec un interrupteur ; le micro et la caméra se déplient en liste de périphériques, et la caméra montre un aperçu en direct pour vous cadrer avant de commencer.
- **Curseur en surbrillance** : activé, c'est le curseur éditable ; désactivé, le simple curseur du système.

**Démarrer l'enregistrement** ouvre le widget d'enregistrement et ferme la fenêtre de l'éditeur ; annuler vous ramène en mode Édition. C'est aussi là que mène **Nouveau projet → Enregistrement d'écran**.

## Capture native ou par le navigateur {#native-vs-browser-capture}

Chaque plateforme enregistre l'écran via un module natif : ScreenCaptureKit sous macOS, Windows Graphics Capture sous Windows 10 à partir de la build 19041, et PipeWire via le portail ScreenCast sous Linux. La webcam n'est capturée nativement que sous Windows ; macOS et Linux l'enregistrent via le navigateur. Sur les trois, elle est enregistrée dans un fichier séparé et intégrée à la composition dans l'éditeur.

La capture par le navigateur ne remplace le module natif que sur les builds de Windows antérieures à la 19041, ou quand une version Windows ou Linux d'OpenScreen ne contient pas son module. Un module natif qui échoue ne se rabat pas sur le navigateur : l'enregistrement signale l'erreur. Voir le [tableau complet des différences entre plateformes](./installation.md#platform-differences).

Une fois l'enregistrement arrêté, passez à [Montage et timeline](./editing-timeline.md) pour le monter, ou à [Médiathèque et clips](./media-library.md) si vous assemblez plusieurs prises.
