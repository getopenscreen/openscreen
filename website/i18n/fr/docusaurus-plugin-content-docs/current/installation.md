---
id: installation
title: Installer OpenScreen sous Windows, macOS et Linux
sidebar_label: Installation
sidebar_position: 2
description: "Installer OpenScreen : Microsoft Store ou winget, .dmg macOS notarisé, .deb, .rpm, .pacman, AppImage et Nix sous Linux, plus la configuration requise."
keywords:
  - installer un enregistreur d'écran
  - télécharger OpenScreen
  - Microsoft Store
  - winget
  - dmg macOS
  - programme d'installation Windows
  - deb Linux
  - rpm Fedora
  - AppImage
  - flake Nix
---

# Installer OpenScreen sous Windows, macOS et Linux

Sous Windows, la voie recommandée est le [Microsoft Store](#windows). Partout ailleurs, téléchargez le dernier programme d'installation pour votre plateforme depuis la [page de téléchargement](/download/), ou directement depuis [GitHub Releases](https://github.com/getopenscreen/openscreen/releases).

## Configuration requise {#system-requirements}

| | Minimum | Recommandé |
|---|---|---|
| **Windows** | Windows 10 version 1903 (build 18362) ou ultérieure, x64, Intel 8e génération / AMD Ryzen série 2000 ou plus récent. La capture native exige Windows 10 version 2004 (build 19041) ou ultérieure ; les builds antérieures se rabattent sur la [capture par le navigateur](#platform-differences) | Windows 11, Intel 12e génération / AMD Ryzen série 4000 ou plus récent |
| **macOS** | macOS 13 (Ventura), exigé par ScreenCaptureKit pour la capture | macOS 14 ou ultérieur |
| **Linux** | x64. `xdg-desktop-portal` et PipeWire, dont l'enregistrement a besoin : le module de capture natif passe par eux, et un échec à ce niveau est signalé comme une erreur. Le repli sur la [capture par le navigateur](#platform-differences) ne s'active que si une version d'OpenScreen ne contient pas le module lui-même. L'audio système exige en plus PipeWire comme serveur son (par défaut sur [Ubuntu 22.10+](https://discourse.ubuntu.com/t/kinetic-kudu-release-notes/27976) et [Fedora 34+](https://fedoraproject.org/wiki/Changes/DefaultPipeWire)). Pour enregistrer les clics de souris sous Wayland, votre utilisateur doit faire partie du groupe `input` : voir [Clics de souris sous Wayland](#mouse-clicks-on-wayland) | Les mêmes, à jour |
| **RAM** | 8 Go | 16 Go |

:::note Anciennes puces graphiques intégrées sous Windows
Rien n'empêche d'installer l'application sur une machine dont la puce graphique intégrée est antérieure à la 8e génération Intel environ (ou à la série AMD Ryzen 2000 équivalente). Mais certaines de ces machines ont des problèmes connus de stabilité des pilotes, qui peuvent empêcher un enregistrement de s'arrêter et d'être sauvegardé : voir [#460](https://github.com/getopenscreen/openscreen/issues/460). Si cela vous arrive, passez par l'icône de la zone de notification ou par **Aide → Enregistrer les diagnostics** juste après l'échec (avant de lancer un autre enregistrement), puis joignez le fichier à un rapport de bug.
:::

## macOS {#macos}

Téléchargez le programme d'installation `.dmg` depuis [Releases](https://github.com/getopenscreen/openscreen/releases) et glissez OpenScreen dans votre dossier Applications. Les versions à partir de la 1.9.0 sont signées avec un certificat Developer ID et notarisées par Apple : Gatekeeper ne les bloque donc pas, et aucune étape dans le terminal n'est nécessaire.

Allez ensuite dans **Réglages Système → Confidentialité et sécurité** et accordez à OpenScreen les autorisations **Enregistrement de l'écran** et **Accessibilité**. Sans Enregistrement de l'écran, il ne peut rien capturer. Accessibilité est nécessaire au curseur éditable, le mode par défaut, pour enregistrer la forme du curseur et les clics : dans ce mode, si vous lancez l'enregistrement sans cette autorisation, une invite s'ouvre avec un lien vers le réglage. Une fois l'autorisation accordée, relancez l'enregistrement pour qu'il démarre.

:::note macOS 15 et versions ultérieures redemandent régulièrement l'autorisation
macOS redemande de temps en temps l'autorisation d'enregistrer l'écran, pour tous les enregistreurs d'écran tiers. Cette invite vient du système d'exploitation : elle ne signifie pas que votre installation est défectueuse ni qu'une mise à jour s'est mal passée. Accordez-la de nouveau quand elle apparaît.
:::

:::tip Vous passez d'une version antérieure à la 1.9.0 ?
Ces versions n'étaient pas signées avec un certificat Developer ID, et macOS lie les autorisations Enregistrement de l'écran et Accessibilité à la signature d'une application : il ne peut donc pas savoir que la nouvelle version est la même application, et les autorisations accordées à l'ancienne ne sont pas reprises. Si une nouvelle version refuse d'enregistrer même après les avoir accordées, supprimez les entrées d'OpenScreen dans ces deux autorisations des Réglages Système, puis relancez l'application et accordez-les de nouveau.
:::

## Windows {#windows}

**Recommandé : Microsoft Store.** [Obtenez OpenScreen sur le Microsoft Store](https://apps.microsoft.com/detail/9MXQ1HQJL5G5), ou installez le même paquet depuis un terminal :

```powershell
winget install --source msstore OpenScreen
```

Microsoft signe le paquet du Store lors de la certification : il s'installe donc sans avertissement de sécurité, et le Store le tient à jour.

**Alternative : programme d'installation autonome.** Téléchargez et lancez le `.exe` depuis [Releases](https://github.com/getopenscreen/openscreen/releases) si vous ne pouvez pas utiliser le Store : Windows LTSC, poste de travail verrouillé, installation hors ligne ou version antérieure précise.

:::note Avertissement SmartScreen sur le .exe
Le `.exe` n'est pas signé : Windows SmartScreen affiche donc **Windows a protégé votre ordinateur** et signale un éditeur inconnu. Choisissez **Informations complémentaires → Exécuter quand même** pour continuer. Téléchargez le `.exe` uniquement depuis la page Releases ; si vous voulez un paquet signé, utilisez la version du Store.
:::

## Linux {#linux}

Quatre paquets x64 sont publiés à chaque version : choisissez celui qui correspond à votre distribution. Sur aarch64, utilisez le flake Nix ci-dessous, qui compile depuis les sources.

**Debian / Ubuntu / Pop!_OS**
```bash
sudo apt install ./Openscreen-Linux-*.deb
```

**Fedora / RHEL / CentOS**
```bash
sudo dnf install ./Openscreen-Linux-*.rpm
```

**Arch / Manjaro**
```bash
sudo pacman -U Openscreen-Linux-*.pacman
```

**Toute distribution (AppImage)**
```bash
chmod +x Openscreen-Linux-*.AppImage
./Openscreen-Linux-*.AppImage
```

Si l'AppImage ne se lance pas à cause d'une erreur de sandbox :
```bash
./Openscreen-Linux-*.AppImage --no-sandbox
```

**NixOS / Nix (flake)**

L'essayer sans l'installer :
```bash
nix run github:getopenscreen/openscreen
```

L'installer dans votre profil utilisateur :
```bash
nix profile install github:getopenscreen/openscreen
```

En tant que module système NixOS :
```nix
{
  inputs.openscreen.url = "github:getopenscreen/openscreen";

  outputs = { nixpkgs, openscreen, ... }: {
    nixosConfigurations.<host> = nixpkgs.lib.nixosSystem {
      modules = [
        openscreen.nixosModules.default
        { programs.openscreen.enable = true; }
      ];
    };
  };
}
```

Les utilisateurs de Home Manager peuvent utiliser `openscreen.homeManagerModules.default` avec le même `programs.openscreen.enable = true;`.

Selon votre environnement de bureau, vous devrez peut-être accorder l'autorisation d'enregistrer l'écran.

### Clics de souris sous Wayland {#mouse-clicks-on-wayland}

Wayland n'expose aucun portail pour les événements d'entrée : OpenScreen lit donc les appuis sur le bouton gauche directement depuis l'interface evdev du noyau (`/dev/input/event*`). Ces nœuds de périphérique appartiennent à `root:input`. Un enregistrement ne distingue donc un clic d'un simple mouvement du curseur que si votre utilisateur fait partie du groupe `input` :

```bash
sudo usermod -aG input $USER
```

Déconnectez-vous puis reconnectez-vous pour que le nouveau groupe soit pris en compte. Rien ne casse sans cela : l'enregistrement fonctionne exactement comme avant, et chaque échantillon du curseur est simplement enregistré comme un déplacement.

La portée est volontairement limitée : seul le bouton gauche de la souris (`BTN_LEFT`) est lu, jamais les frappes au clavier. Pour désactiver complètement ce lecteur, même là où l'autorisation existe, définissez `OPENSCREEN_DISABLE_CLICK_CAPTURE=1` dans l'environnement depuis lequel OpenScreen est lancé.

:::caution
Le groupe `input` ne se limite pas à OpenScreen : tout programme lancé sous votre compte peut alors lire tous les périphériques d'entrée, clavier compris. Ne vous y ajoutez que si vous l'acceptez sur cette machine.
:::

**Pavés tactiles :** seul un clic physique est enregistré, quand vous appuyez sur le pavé jusqu'à ce qu'il s'enfonce. **Le tapotement pour cliquer (tap-to-click) ne l'est pas** : la pile d'entrée de votre compositeur (libinput) synthétise ces tapotements pour son propre usage et ne les renvoie jamais au périphérique du noyau que lit OpenScreen ; il n'y a donc rien à lire au niveau d'evdev. Avec une souris, ou un pavé tactile dont le tapotement pour cliquer est désactivé, chaque clic est enregistré.

## Différences entre plateformes {#platform-differences}

Les outils de montage sont les mêmes partout : zooms, arrière-plans, recadrage, coupe et vitesse, annotations, transcription, sous-titres et projets. Tous les formats d'export fonctionnent sur toutes les plateformes ; ce qui diffère, c'est la **capture**, et l'encodeur que peut utiliser l'export MP4 sous Linux :

| | macOS | Windows | Linux |
|---|---|---|---|
| Chaîne de capture | Native (ScreenCaptureKit) | Native (Windows Graphics Capture) à partir de la build 19041 ; repli sur le navigateur sur les builds antérieures ou sans le module | Native (PipeWire via le portail ScreenCast) ; repli sur le navigateur sans le module, avec perte de l'encodage matériel et de la télémétrie du curseur |
| Thèmes de curseur personnalisés / effets de clic | ✅ : les clics et la forme du curseur exigent l'autorisation Accessibilité | ✅ | ✅ sous Wayland : la capture des clics exige le groupe `input` ([détails](#mouse-clicks-on-wayland)) |
| Webcam | Capture par le navigateur, enregistrée dans un fichier séparé (reste utilisable en incrustation d'image) | Capture native, enregistrée dans un fichier séparé | Capture par le navigateur, enregistrée dans un fichier séparé (reste utilisable en incrustation d'image) |
| Audio système | Fonctionne sans configuration ; invite d'autorisation sur macOS 14.2+ | Fonctionne sans configuration | Exige PipeWire comme serveur son (par défaut sur Ubuntu 22.10+, Fedora 34+) |
| Export MP4 | ✅ | ✅ | ✅ : H.264 sur le GPU via VAAPI quand la pile graphique le permet (voir la note ci-dessous), en logiciel sinon ; H.265 uniquement en logiciel |
| Export GIF | ✅ | ✅ | ✅ |
| Transcription en local | Metal (Apple Silicon) / CPU | Vulkan / CPU | Vulkan / CPU |

:::note Export MP4 sous Linux
Le moteur de composition GPU qui sert à l'aperçu en direct et à l'export MP4 a trois backends (Direct3D 11 sous Windows, Metal sous macOS, wgpu/WGSL sous Linux) et il est inclus dans les trois builds. Sous Linux, un export H.264 confie chaque image composée à `h264_vaapi` sans copie côté CPU quand le pilote GPU expose VAAPI *et* que le périphérique Vulkan peut transmettre l'image sous forme de dmabuf (`VK_KHR_external_memory_fd` et `VK_EXT_external_memory_dma_buf`). S'il manque l'un de ces éléments (pas de nœud de rendu, un pilote sans VAAPI, un périphérique Vulkan sans ces extensions), l'export se rabat sur un encodeur logiciel et prend simplement plus de temps ; rien d'autre ne change. Sous Linux, les exports H.265 utilisent toujours l'encodeur logiciel.
:::

Les pages [Windows](/screen-recorder-windows/), [Mac](/screen-recorder-mac/) et [Linux](/screen-recorder-linux/) résument ce que fait OpenScreen sur chaque système, et les cas où un autre outil convient mieux.

Étape suivante : le [Démarrage rapide](./quick-start.md) vous guide dans votre premier enregistrement.
