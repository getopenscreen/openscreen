---
id: export
title: Exporter un enregistrement d'écran en MP4 ou en GIF
sidebar_position: 9
sidebar_label: Export
description: "Exporter depuis OpenScreen en MP4 (720p, 1080p ou source, H.264 ou H.265) ou en GIF animé, et comprendre le rendu et l'encodage GPU sur chaque système."
keywords:
  - exporter en MP4
  - H.264
  - H.265
  - GIF animé
  - export vidéo
  - 1080p
---

# Exporter un enregistrement d'écran en MP4 ou en GIF

Cliquez sur **Exporter** dans la barre supérieure pour ouvrir la fenêtre d'export.

## Formats {#formats}

- **MP4** : qualité **720p**, **1080p** ou **Source** ; fréquence d'images 24 / 30 / 60 fps ; codec **H.264** (celui par défaut, et celui qu'acceptent le plus de lecteurs) ou **H.265**.
- **GIF** : fréquence d'images 15 / 20 / 25 / 30 fps, taille Medium / Large / Original, et un interrupteur **Boucle**.

:::note
VP9 a été retiré. Il n'existe aucun encodeur VP9 matériel sur les GPU que vise le pipeline natif, et le repli logiciel était bien trop lent pour être proposé comme une option en apparence équivalente aux autres.
:::

## Résolution {#resolution}

La fenêtre indique la taille exacte en pixels que produira chaque niveau de qualité, selon le format de votre timeline.

**Source** se cale sur l'emprise réelle, après recadrage, du *plus petit* clip, ce qui exclut par construction tout agrandissement : aucun clip de la timeline n'est jamais étiré au-delà de sa résolution réelle. Les niveaux fixes 720p et 1080p visent quant à eux une longueur de petit côté donnée, quels que soient les clips : ils peuvent donc encore agrandir un petit clip, et la fenêtre signale alors le niveau concerné par un badge.

## Exporter {#exporting}

1. Réglez le format et la qualité, puis cliquez sur **Exporter**.
2. Choisissez un emplacement dans la boîte de dialogue de fichiers du système.
3. La fenêtre affiche la progression réelle de l'encodeur : images rendues sur le total, plus un temps restant estimé, puis une phase d'écriture.
4. En cas de réussite, **Afficher dans le dossier** ouvre directement l'emplacement du fichier.

En cas d'échec pendant le rendu ou l'écriture, la fenêtre affiche l'erreur pour que vous puissiez réessayer.

## Comment le MP4 est rendu {#how-mp4-is-rendered}

L'export MP4 passe par le même moteur de composition natif en Rust que celui qui dessine l'aperçu en direct (Direct3D 11 sous Windows, Metal sous macOS, wgpu/WGSL sous Linux), un clip à la fois, sur un seul périphérique GPU : démultiplexage → décodage → composition → encodage → multiplexage. Sous Windows, les encodeurs AMD (AMF) et NVIDIA (NVENC) prennent l'image composée directement sur le GPU, sans rapatriement en mémoire CPU entre les deux ; Intel Quick Sync, Media Foundation et le repli logiciel reçoivent une copie en mémoire système. Sous macOS, c'est VideoToolbox qui encode : un export H.264 est rendu directement dans le tampon propre à l'encodeur quand VideoToolbox le permet, tandis que le chemin de reprise H.264, chaque export H.265 et le repli logiciel reçoivent une copie en mémoire système. Sous Linux, un export H.264 est confié à l'encodeur GPU via VAAPI, là aussi sans copie côté CPU, quand la pile de pilotes le permet ; sinon, et pour chaque export H.265, l'image est recopiée en mémoire système puis encodée en logiciel. L'aperçu se met en pause pendant ce temps, pour que les deux ne se disputent pas le GPU.

Comme l'aperçu et l'export s'appuient sur la même description de scène, l'image que vous regardez est l'image que vous obtenez : il n'existe pas de moteur de rendu d'export séparé qui pourrait diverger.

:::note Prise en charge par plateforme
Les exports MP4 et GIF fonctionnent tous deux sous Windows, macOS et Linux. Ce qui diffère, c'est la vitesse sous Linux : H.264 n'y utilise le GPU que si VAAPI et le périphérique Vulkan le permettent, et H.265 y est toujours encodé en logiciel, si bien que ces exports y prennent plus de temps. La note [Export MP4 sous Linux](./installation.md#platform-differences) liste ce dont la voie GPU a besoin.
:::

## Fichier exporté ou fichier de projet {#exported-file-vs-project-file}

L'export produit une vidéo (ou un GIF) finie et aplatie : elle n'est plus modifiable ensuite. Si vous voulez pouvoir continuer le montage plus tard, enregistrez plutôt un **projet** `.openscreen` (voir [Montage et timeline](./editing-timeline.md#saving-your-work)) ; les fichiers de projet conservent intacts chaque clip, zoom, coupe, annotation et réglage.
