---
id: installation
title: OpenScreen unter Windows, macOS und Linux installieren
sidebar_label: Installation
sidebar_position: 2
description: "OpenScreen installieren: Microsoft Store oder winget, notarisierte macOS-.dmg, unter Linux .deb, .rpm, .pacman, AppImage und Nix, plus Systemanforderungen."
keywords:
  - Bildschirmrekorder installieren
  - OpenScreen herunterladen
  - Microsoft Store
  - winget
  - macOS dmg
  - Windows-Installer
  - Linux deb
  - Fedora rpm
  - AppImage
  - Nix-Flake
---

# OpenScreen unter Windows, macOS und Linux installieren

Unter Windows ist der [Microsoft Store](#windows) der empfohlene Weg. Auf allen anderen Systemen lädst du den neuesten Installer für deine Plattform von der [Download-Seite](/download/) herunter oder direkt von [GitHub Releases](https://github.com/getopenscreen/openscreen/releases).

## Systemanforderungen {#system-requirements}

| | Minimum | Empfohlen |
|---|---|---|
| **Windows** | Windows 10 Version 1903 (Build 18362) oder neuer, x64, Intel ab 8. Generation / AMD Ryzen ab Serie 2000. Die native Aufnahme braucht Windows 10 Version 2004 (Build 19041) oder neuer; ältere Builds nehmen über die [Browser-Aufnahme als Fallback](#platform-differences) auf | Windows 11, Intel ab 12. Generation / AMD Ryzen ab Serie 4000 |
| **macOS** | macOS 13 (Ventura), das ScreenCaptureKit für die Aufnahme voraussetzt | macOS 14 oder neuer |
| **Linux** | x64. `xdg-desktop-portal` und PipeWire, die die Aufnahme braucht: Das native Aufnahme-Hilfsprogramm läuft über sie, und schlägt dort etwas fehl, wird das als Fehler gemeldet. Die [Browser-Aufnahme als Fallback](#platform-differences) springt nur ein, wenn einem Build das Hilfsprogramm selbst fehlt. Systemaudio braucht zusätzlich PipeWire als Soundserver (Standard ab [Ubuntu 22.10](https://discourse.ubuntu.com/t/kinetic-kudu-release-notes/27976) und [Fedora 34](https://fedoraproject.org/wiki/Changes/DefaultPipeWire)). Damit unter Wayland Mausklicks aufgenommen werden, muss dein Benutzer in der Gruppe `input` sein, siehe [Mausklicks unter Wayland](#mouse-clicks-on-wayland) | Wie Minimum, jeweils aktuell |
| **RAM** | 8 GB | 16 GB |

:::note Ältere integrierte Grafik unter Windows
Auf Rechnern mit integrierter Grafik, die älter ist als etwa Intels 8. Generation (oder die entsprechende AMD-Ryzen-Serie 2000), lässt sich OpenScreen trotzdem installieren. Einige davon haben aber bekannte Stabilitätsprobleme mit dem Treiber, durch die sich eine Aufnahme unter Umständen nicht stoppen und speichern lässt, siehe [#460](https://github.com/getopenscreen/openscreen/issues/460). Wenn dir das passiert, öffne direkt nach dem Fehler (bevor du eine neue Aufnahme startest) das Symbol im Infobereich oder **Help → Save Diagnostics** und hänge die Datei an einen Fehlerbericht an.
:::

## macOS {#macos}

Lade den `.dmg`-Installer von [Releases](https://github.com/getopenscreen/openscreen/releases) herunter und ziehe OpenScreen in deinen Ordner „Programme“. Builds ab 1.9.0 sind mit einem Developer-ID-Zertifikat signiert und von Apple notarisiert. Gatekeeper blockiert sie deshalb nicht, und du brauchst keinen Schritt im Terminal.

Öffne dann **Systemeinstellungen → Datenschutz & Sicherheit** und erteile OpenScreen die Berechtigungen **Bildschirmaufnahme** und **Bedienungshilfen**. Ohne „Bildschirmaufnahme“ kann OpenScreen überhaupt nicht aufnehmen. „Bedienungshilfen“ braucht der standardmäßige bearbeitbare Cursor, um Cursorform und Klicks aufzuzeichnen: In diesem Modus öffnet ein Klick auf Aufnahme ohne diese Berechtigung einen Hinweis mit einem Link zur Einstellung, und die Aufnahme startet, sobald du die Berechtigung erteilt und erneut auf Aufnahme geklickt hast.

:::note macOS 15 und neuer fragt regelmäßig erneut
macOS fragt die Berechtigung zur Bildschirmaufnahme von Zeit zu Zeit neu ab, und zwar für jeden Bildschirmrekorder von Drittanbietern. Diese Abfrage kommt vom Betriebssystem. Sie bedeutet nicht, dass deine Installation defekt ist oder ein Update schiefgegangen ist. Erteile die Berechtigung erneut, wenn du gefragt wirst.
:::

:::tip Update von einer Version vor 1.9.0?
Diese Builds waren nicht mit einem Developer-ID-Zertifikat signiert, und macOS bindet die Berechtigungen für Bildschirmaufnahme und Bedienungshilfen an die Signatur einer App. macOS kann deshalb nicht erkennen, dass der neue Build dieselbe App ist, und die Berechtigungen der alten Version werden nicht übernommen. Wenn eine neue Version auch nach dem Erteilen nicht aufnimmt, entferne die Einträge von OpenScreen unter beiden Berechtigungen in den Systemeinstellungen, starte die App dann neu und erteile die Berechtigungen noch einmal.
:::

## Windows {#windows}

**Empfohlen: Microsoft Store.** [Hol dir OpenScreen im Microsoft Store](https://apps.microsoft.com/detail/9MXQ1HQJL5G5) oder installiere dasselbe Paket im Terminal:

```powershell
winget install --source msstore OpenScreen
```

Microsoft signiert das Store-Paket bei der Zertifizierung. Es installiert sich deshalb ohne Sicherheitswarnung, und der Store hält es aktuell.

**Alternative: eigenständiger Installer.** Lade die `.exe` von [Releases](https://github.com/getopenscreen/openscreen/releases) herunter und führe sie aus, wenn du den Store nicht nutzen kannst: Windows LTSC, ein stark eingeschränkter Arbeitsrechner, eine Offline-Installation oder eine bestimmte ältere Version.

:::note SmartScreen-Warnung bei der .exe
Die `.exe` ist nicht codesigniert. Windows SmartScreen zeigt deshalb **Der Computer wurde durch Windows geschützt** und meldet einen unbekannten Herausgeber. Wähle **Weitere Informationen → Trotzdem ausführen**, um fortzufahren. Lade die `.exe` nur von der Releases-Seite herunter; wenn du ein signiertes Paket willst, nimm die Store-Version.
:::

## Linux {#linux}

Pro Release erscheinen vier x64-Pakete. Wähle das passende für deine Distribution. Auf aarch64 nimmst du den Nix-Flake unten, der aus dem Quellcode baut.

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

**Jede Distribution (AppImage)**
```bash
chmod +x Openscreen-Linux-*.AppImage
./Openscreen-Linux-*.AppImage
```

Wenn das AppImage mit einem Sandbox-Fehler nicht startet:
```bash
./Openscreen-Linux-*.AppImage --no-sandbox
```

**NixOS / Nix (Flake)**

Ohne Installation ausprobieren:
```bash
nix run github:getopenscreen/openscreen
```

In dein Benutzerprofil installieren:
```bash
nix profile install github:getopenscreen/openscreen
```

Als NixOS-Systemmodul:
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

Wer Home Manager nutzt, kann `openscreen.homeManagerModules.default` mit demselben `programs.openscreen.enable = true;` verwenden.

Je nach Desktop-Umgebung musst du eventuell eine Berechtigung zur Bildschirmaufnahme erteilen.

### Mausklicks unter Wayland {#mouse-clicks-on-wayland}

Wayland bietet kein Portal für Eingabeereignisse. OpenScreen liest das Drücken der linken Maustaste deshalb direkt über die evdev-Schnittstelle des Kernels (`/dev/input/event*`). Diese Gerätedateien gehören `root:input`. Eine Aufnahme kann einen Klick deshalb nur dann von einer normalen Cursorbewegung unterscheiden, wenn dein Benutzer in der Gruppe `input` ist:

```bash
sudo usermod -aG input $USER
```

Melde dich ab und wieder an, damit die neue Gruppe wirksam wird. Ohne sie geht nichts kaputt: Die Aufnahme funktioniert genau wie vorher, und jede Cursorposition wird einfach als Bewegung aufgezeichnet.

Der Umfang ist bewusst eng: Gelesen wird nur die linke Maustaste (`BTN_LEFT`), niemals Tastatureingaben. Um das Auslesen auch dort ganz abzuschalten, wo die Berechtigung besteht, setze `OPENSCREEN_DISABLE_CLICK_CAPTURE=1` in der Umgebung, aus der OpenScreen gestartet wird.

:::caution
Die Gruppe `input` gilt nicht nur für OpenScreen: Danach kann jedes Programm, das unter deinem Benutzer läuft, alle Eingabegeräte auslesen, auch die Tastatur. Füge dich nur hinzu, wenn du das auf diesem Rechner akzeptierst.
:::

**Touchpads:** Aufgenommen wird nur ein physischer Klick, bei dem du das Pad herunterdrückst, bis es nachgibt. **Tippen zum Klicken wird nicht aufgenommen**: Der Eingabe-Stack deines Compositors (libinput) erzeugt diese Taps für den eigenen Gebrauch und schreibt sie nie an das Kernel-Gerät zurück, das OpenScreen liest. Auf evdev-Ebene gibt es also nichts zu sehen. Mit einer Maus oder mit einem Touchpad, bei dem Tippen zum Klicken ausgeschaltet ist, wird jeder Klick aufgenommen.

## Unterschiede zwischen den Plattformen {#platform-differences}

Die Bearbeitungswerkzeuge sind überall gleich: Zooms, Hintergründe, Zuschneiden/Kürzen/Geschwindigkeit, Annotationen, Transkription, Untertitel und Projekte. Jedes Exportformat funktioniert auf jeder Plattform. Unterschiede gibt es bei der **Aufnahme** und bei der Frage, welchen Encoder der MP4-Export unter Linux nutzen kann:

| | macOS | Windows | Linux |
|---|---|---|---|
| Aufnahme-Pipeline | Nativ (ScreenCaptureKit) | Nativ (Windows Graphics Capture) ab Build 19041; Browser-Fallback auf älteren Builds oder ohne das Hilfsprogramm | Nativ (PipeWire über das ScreenCast-Portal); Browser-Fallback ohne das Hilfsprogramm, dann ohne Hardware-Encoding und ohne Cursor-Telemetrie |
| Eigene Cursor-Themes / Klickeffekte | ✅, Klicks und Cursorform brauchen die Berechtigung „Bedienungshilfen“ | ✅ | ✅ unter Wayland, die Klickerfassung braucht die Gruppe `input` ([Details](#mouse-clicks-on-wayland)) |
| Webcam | Browser-Aufnahme, als separate Datei gespeichert (funktioniert trotzdem als Bild-im-Bild) | Native Aufnahme, als separate Datei gespeichert | Browser-Aufnahme, als separate Datei gespeichert (funktioniert trotzdem als Bild-im-Bild) |
| Systemaudio | Funktioniert ohne Einrichtung; Berechtigungsabfrage ab macOS 14.2 | Funktioniert ohne Einrichtung | Braucht PipeWire als Soundserver (Standard ab Ubuntu 22.10, Fedora 34) |
| MP4-Export | ✅ | ✅ | ✅, H.264 auf der GPU über VAAPI, wenn der Grafik-Stack es zulässt (siehe Hinweis unten), sonst in Software; H.265 nur in Software |
| GIF-Export | ✅ | ✅ | ✅ |
| Lokale Transkription | Metal (Apple Silicon) / CPU | Vulkan / CPU | Vulkan / CPU |

:::note MP4-Export unter Linux
Der GPU-Compositor hinter der Live-Vorschau und dem MP4-Export hat drei Backends (Direct3D 11 unter Windows, Metal unter macOS, wgpu/WGSL unter Linux) und ist in allen drei Builds enthalten. Unter Linux übergibt ein H.264-Export jedes zusammengesetzte Bild ohne CPU-Kopie an `h264_vaapi`, wenn der GPU-Treiber VAAPI bereitstellt *und* das Vulkan-Gerät das Bild als dmabuf weitergeben kann (`VK_KHR_external_memory_fd` und `VK_EXT_external_memory_dma_buf`). Fehlt davon etwas (kein Render-Node, ein Treiber ohne VAAPI, ein Vulkan-Gerät ohne diese Erweiterungen), weicht der Export auf einen Software-Encoder aus und dauert einfach länger; sonst ändert sich nichts. H.265-Exporte nutzen unter Linux immer den Software-Encoder.
:::

Was OpenScreen auf dem jeweiligen System leistet und wann ein anderes Tool besser passt, fassen die Seiten zu [Windows](/screen-recorder-windows/), [Mac](/screen-recorder-mac/) und [Linux](/screen-recorder-linux/) zusammen.

Weiter: Der [Schnellstart](./quick-start.md) führt dich durch deine erste Aufnahme.
