---
id: faq
title: "FAQ OpenScreen : licence, confidentialité et liens"
sidebar_label: FAQ
description: "OpenScreen est-il gratuit en usage commercial ? Oui, sous licence MIT. Réponses : filigrane, hors ligne, vie privée, signature, liens officiels."
keywords:
  - FAQ OpenScreen
  - gratuit pour un usage commercial
  - licence MIT
  - sans filigrane
  - enregistreur d'écran hors ligne
  - projet OpenScreen d'origine
---

# FAQ OpenScreen

OpenScreen est un enregistreur d'écran et éditeur vidéo gratuit, sous licence MIT, pour Windows, macOS et Linux. Il est gratuit pour un usage commercial, sans compte et sans filigrane. Cette page répond aux questions que l'on se pose avant de l'installer : licence, ce qui passe par le réseau, signature des programmes d'installation et sites officiels. Ce n'est pas le même produit qu'Open Screen, sur openscreen.io.

## OpenScreen est-il gratuit pour un usage commercial ? {#is-openscreen-free-for-commercial-use}

**Oui.** OpenScreen est publié sous [licence MIT](https://github.com/getopenscreen/openscreen/blob/main/LICENSE).

- Vous pouvez l'utiliser, le copier, le modifier, le distribuer et le vendre. La seule condition est de conserver l'avis de copyright et l'avis d'autorisation avec les copies du logiciel.
- Le texte de la licence couvre le logiciel. Il ne dit rien des vidéos que vous réalisez avec.
- Il n'y a ni compte, ni offre payante, ni fonctionnalité premium.

## OpenScreen ajoute-t-il un filigrane ? {#does-openscreen-add-a-watermark}

**Non.** Les exports MP4 et GIF ne portent aucun filigrane, et il n'existe aucune version payante qui en retirerait un. Consultez [Export](./export.md) pour les formats.

## OpenScreen fonctionne-t-il hors ligne ? {#does-openscreen-work-offline}

**L'enregistrement, la transcription et le rendu s'exécutent sur votre machine.** OpenScreen n'a aucune fonction de mise en ligne : vos enregistrements restent sur votre disque. L'application établit tout de même quelques connexions réseau, si bien qu'il serait faux de la dire « entièrement hors ligne » :

- **Google Fonts, à chaque lancement.** L'application charge les polices de ses annotations de texte depuis les serveurs de Google, dont fonts.googleapis.com.
- **huggingface.co, une fois.** La première transcription télécharge le modèle Whisper, environ 264 Mo, et le vérifie à l'aide d'une empreinte SHA-256. Ensuite, la transcription n'a plus besoin de connexion.
- **github.com et api.github.com.** Les versions qui se mettent à jour d'elles-mêmes vérifient la présence d'une nouvelle version toutes les 24 heures, et quand vous le demandez. Par défaut, elles se contentent de vous signaler qu'une version est disponible.
- **Votre fournisseur d'IA, seulement si vous en connectez un.** Le montage par chat envoie vos messages et les données du projet qu'il lit, comme la timeline et la transcription. La traduction des sous-titres envoie le texte des sous-titres. Les deux restent désactivés tant que vous n'avez pas connecté de fournisseur. Voir [Montage par IA](./ai-editing.md).

## OpenScreen collecte-t-il des statistiques d'usage ou des rapports de plantage ? {#does-openscreen-collect-analytics-or-crash-reports}

**Non.** Le code de l'application ne contient aucun SDK de statistiques d'usage ni de rapport de plantage.

- Il n'existe aucun serveur OpenScreen auquel l'application pourrait faire remonter quoi que ce soit.
- Les clés des fournisseurs d'IA sont stockées chiffrées avec `safeStorage` d'Electron. Si le chiffrement n'est pas disponible, la clé n'est pas enregistrée.

## Peut-on installer OpenScreen en toute sécurité ? {#is-openscreen-safe-to-install}

**Le code source est public, et les versions macOS et Store sont signées.** Ne téléchargez que depuis les liens de la section [Liens officiels](#what-are-the-official-openscreen-links).

- **macOS :** les versions à partir de la 1.9.0 sont signées avec un Developer ID Apple et notarisées.
- **Windows, Microsoft Store :** Microsoft signe le paquet, qui s'installe donc sans avertissement.
- **Windows, programme d'installation `.exe` :** non signé. SmartScreen affiche « Windows a protégé votre ordinateur ». Choisissez **Informations complémentaires**, puis **Exécuter quand même**, ou utilisez plutôt la version du Store.

La page [Installation](./installation.md) donne les étapes pour chaque plateforme.

## Sur quels systèmes OpenScreen fonctionne-t-il ? {#which-systems-does-openscreen-run-on}

| Système | Minimum | Paquets |
|---|---|---|
| macOS | 13 Ventura | `.dmg` pour Apple Silicon et pour Intel |
| Windows | 10 version 1903, x64 | Microsoft Store, programme d'installation `.exe` |
| Linux | x64, PipeWire et xdg-desktop-portal | AppImage, `.deb`, `.rpm`, `.pacman`, flake Nix |

- Sous Windows, la capture native exige la build 19041 (Windows 10 version 2004). Les builds antérieures se rabattent sur la capture par le navigateur.
- Prévoyez 8 Go de RAM ; 16 Go sont recommandés.

## Existe-t-il une version ARM64 pour Windows ou Linux ? {#is-there-an-arm64-build-for-windows-or-linux}

**Pas sous forme de paquet.** Les versions Windows et Linux sont uniquement x64.

- Sur Linux ARM64, le flake Nix compile OpenScreen depuis les sources pour `aarch64-linux`.
- Les Mac Apple Silicon disposent d'un `.dmg` natif.

## Peut-on installer OpenScreen avec winget, Homebrew ou Flathub ? {#can-i-install-openscreen-with-winget-homebrew-or-flathub}

- **winget :** oui, via la source du Store : `winget install --source msstore OpenScreen`.
- **Homebrew :** il n'existe pas de cask officiel. En septembre 2026, le tap `siddharthvaddem/openscreen` du projet d'origine reste bloqué sur la version 1.5.0. Utilisez plutôt le `.dmg` de la [page de téléchargement](/download/).
- **Flathub :** il n'y a pas de fiche.

## S'agit-il du projet OpenScreen d'origine ? {#is-this-the-original-openscreen-project}

**C'en est la continuation.**

- Siddharth Vaddem a créé OpenScreen et archivé le [dépôt d'origine](https://github.com/siddharthvaddem/openscreen) après la v1.5.0.
- Le développement a migré vers [getopenscreen/openscreen](https://github.com/getopenscreen/openscreen) avec son accord, sous le même nom et la même licence MIT.
- Le README archivé présente ce projet comme un projet dérivé porté par la communauté et mené par l'un des principaux contributeurs. Il s'agit d'Etienne Lescot, qui le maintient. Le lien du README, github.com/EtienneLescot/openscreen, redirige vers le dépôt actuel.
- Le dépôt archivé ne reçoit plus de mises à jour. [Picking up OpenScreen (en anglais)](/blog/2026/06/15/picking-up-openscreen/) raconte la passation.

## OpenScreen a-t-il un lien avec openscreen.io ou openscreen.net ? {#is-openscreen-related-to-openscreenio-or-openscreennet}

- **openscreen.io :** non. C'est un autre produit, Open Screen, que son site présente comme un enregistreur d'écran pour macOS. OpenScreen n'y est pas affilié.
- **openscreen.net :** ce n'est pas un site officiel d'OpenScreen.

## Quels sont les liens officiels d'OpenScreen ? {#what-are-the-official-openscreen-links}

| Quoi | Lien |
|---|---|
| Site web | [getopenscreen.com](https://getopenscreen.com/) |
| Code source, versions et tickets | [github.com/getopenscreen/openscreen](https://github.com/getopenscreen/openscreen) |
| Microsoft Store | [apps.microsoft.com/detail/9MXQ1HQJL5G5](https://apps.microsoft.com/detail/9MXQ1HQJL5G5) |
| Discord | [getopenscreen.com/discord](https://getopenscreen.com/discord/) |
| Projet d'origine, archivé et en lecture seule | [github.com/siddharthvaddem/openscreen](https://github.com/siddharthvaddem/openscreen) |

## Que se passe-t-il si un enregistrement est interrompu ? {#what-happens-if-a-recording-is-interrupted}

Sous Windows et macOS, les enregistreurs natifs écrivent un MP4 fragmenté, par fragments d'une seconde. Si un enregistrement est interrompu, le fichier reste lisible jusqu'au dernier fragment complet.

Les signalements de bugs et les demandes de fonctionnalités vont dans les [tickets GitHub](https://github.com/getopenscreen/openscreen/issues).

## Que ne fait pas OpenScreen ? {#what-doesnt-openscreen-do}

Si vous avez besoin de l'une de ces fonctions, OpenScreen n'est pas le bon outil :

- **Partage hébergé.** Pas de liens de partage, de stockage cloud, d'espaces d'équipe ni de commentaires. Vos fichiers restent sur votre disque. Voir [OpenScreen comme alternative à Loom](/alternatives/loom/).
- **Diffusion en direct.** Voir [OpenScreen vs OBS Studio](/compare/openscreen-vs-obs/).
- **Fichiers de sous-titres.** Les sous-titres sont incrustés dans la vidéo. Il n'y a pas d'export SRT ni VTT. Voir [Sous-titres et transcription](./captions.md).
- **Mobile.** Pas d'application mobile, ni de capture iOS ou Android.

## Comment commencer ? {#how-do-i-get-started}

1. Récupérez le programme d'installation pour votre système sur la [page de téléchargement](/download/).
2. Suivez [Installation](./installation.md) pour votre plateforme.
3. Enregistrez, coupez et exportez une première vidéo avec le [Démarrage rapide](./quick-start.md).

## Sources {#sources}

Vérifiées en septembre 2026 :

- Dépôt d'origine et son avis d'archivage : [github.com/siddharthvaddem/openscreen](https://github.com/siddharthvaddem/openscreen)
- Tap Homebrew du projet d'origine : [github.com/siddharthvaddem/homebrew-openscreen](https://github.com/siddharthvaddem/homebrew-openscreen)
- Open Screen : [openscreen.io](https://openscreen.io/)

Open Screen, Loom, OBS Studio et les autres noms de produits cités sur cette page sont des marques de leurs propriétaires respectifs. OpenScreen n'est affilié ni à Open Screen (openscreen.io), ni à Loom, ni à OBS Studio.
