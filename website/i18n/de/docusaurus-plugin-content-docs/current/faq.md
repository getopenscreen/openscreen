---
id: faq
title: "OpenScreen-FAQ: Lizenz, Datenschutz und Links"
sidebar_label: FAQ
description: "Ist OpenScreen für kommerzielle Nutzung kostenlos? Ja, unter MIT-Lizenz. Antworten zu Wasserzeichen, Offline-Nutzung, Datenschutz, signierten Installern und offiziellen Links."
keywords:
  - OpenScreen FAQ
  - kostenlos für kommerzielle Nutzung
  - MIT-Lizenz
  - ohne Wasserzeichen
  - Bildschirmrekorder offline
  - OpenScreen Originalprojekt
---

# OpenScreen-FAQ

OpenScreen ist ein kostenloser Bildschirmrekorder und Videoeditor unter MIT-Lizenz für Windows, macOS und Linux. Er ist auch für kommerzielle Nutzung kostenlos, ohne Konto und ohne Wasserzeichen. Diese Seite beantwortet die Fragen, die vor der Installation gestellt werden: Lizenz, was über das Netzwerk geht, wie die Installer signiert sind und welche Websites offiziell sind. OpenScreen ist nicht dasselbe Produkt wie Open Screen auf openscreen.io.

## Ist OpenScreen für kommerzielle Nutzung kostenlos? {#is-openscreen-free-for-commercial-use}

**Ja.** OpenScreen steht unter der [MIT-Lizenz](https://github.com/getopenscreen/openscreen/blob/main/LICENSE).

- Du darfst es nutzen, kopieren, verändern, weitergeben und verkaufen. Die einzige Bedingung: Copyright- und Lizenzhinweis müssen in Kopien der Software erhalten bleiben.
- Der Lizenztext gilt für die Software. Über die Videos, die du damit machst, sagt er nichts.
- Es gibt kein Konto, keine kostenpflichtige Stufe und keine Premium-Funktion.

## Fügt OpenScreen ein Wasserzeichen hinzu? {#does-openscreen-add-a-watermark}

**Nein.** MP4- und GIF-Exporte haben kein Wasserzeichen, und es gibt keine kostenpflichtige Version, die eines entfernt. Die Formate stehen unter [Export](./export.md).

## Funktioniert OpenScreen offline? {#does-openscreen-work-offline}

**Aufnahme, Transkription und Rendering laufen auf deinem Rechner.** OpenScreen hat keine Upload-Funktion, deine Aufnahmen bleiben also auf deiner Festplatte. Die App baut trotzdem einige Netzwerkverbindungen auf, deshalb wäre „komplett offline“ falsch:

- **Google Fonts, bei jedem Start.** Die App lädt die Schriften für ihre Textannotationen von Googles Servern, darunter fonts.googleapis.com.
- **huggingface.co, einmalig.** Die erste Transkription lädt das Whisper-Modell herunter, etwa 264 MB, und prüft es gegen einen SHA-256-Hash. Danach braucht die Transkription keine Verbindung mehr.
- **github.com und api.github.com.** Builds, die sich selbst aktualisieren, suchen alle 24 Stunden und auf deine Anfrage nach einer neuen Version. Standardmäßig melden sie nur, dass eine verfügbar ist.
- **Dein KI-Anbieter, nur wenn du einen verbindest.** Die Chat-Bearbeitung sendet deine Nachrichten und die Projektdaten, die sie liest, etwa Zeitleiste und Transkript. Die Untertitelübersetzung sendet den Untertiteltext. Beides bleibt aus, bis du einen Anbieter verbindest. Siehe [KI-Bearbeitung](./ai-editing.md).

## Sammelt OpenScreen Analysedaten oder Absturzberichte? {#does-openscreen-collect-analytics-or-crash-reports}

**Nein.** Der Code der App enthält kein SDK für Analysen oder Absturzberichte.

- Es gibt keinen OpenScreen-Server, an den die App etwas melden könnte.
- API-Schlüssel für KI-Anbieter werden verschlüsselt mit Electrons `safeStorage` gespeichert. Ist keine Verschlüsselung verfügbar, wird der Schlüssel nicht gespeichert.

## Ist die Installation von OpenScreen sicher? {#is-openscreen-safe-to-install}

**Der Quellcode ist öffentlich, und die Builds für macOS und den Store sind signiert.** Lade nur über die Links unter [Offizielle Links](#what-are-the-official-openscreen-links) herunter.

- **macOS:** Builds ab 1.9.0 sind mit einer Apple Developer ID signiert und notarisiert.
- **Windows, Microsoft Store:** Microsoft signiert das Paket, es installiert sich also ohne Warnung.
- **Windows, `.exe`-Installer:** nicht codesigniert. SmartScreen zeigt „Der Computer wurde durch Windows geschützt“. Wähle **Weitere Informationen** und dann **Trotzdem ausführen**, oder nimm stattdessen die Store-Version.

Unter [Installation](./installation.md) stehen die Schritte für jede Plattform.

## Auf welchen Systemen läuft OpenScreen? {#which-systems-does-openscreen-run-on}

| System | Minimum | Pakete |
|---|---|---|
| macOS | 13 Ventura | `.dmg` für Apple Silicon und für Intel |
| Windows | 10 Version 1903, x64 | Microsoft Store, `.exe`-Installer |
| Linux | x64, PipeWire und xdg-desktop-portal | AppImage, `.deb`, `.rpm`, `.pacman`, Nix-Flake |

- Unter Windows braucht die native Aufnahme Build 19041 (Windows 10 Version 2004). Ältere Builds weichen auf die Browser-Aufnahme aus.
- Plane 8 GB RAM ein, empfohlen sind 16 GB.

## Gibt es einen ARM64-Build für Windows oder Linux? {#is-there-an-arm64-build-for-windows-or-linux}

**Kein fertiges Paket.** Releases für Windows und Linux gibt es nur für x64.

- Unter ARM64-Linux baut der Nix-Flake OpenScreen aus dem Quellcode für `aarch64-linux`.
- Macs mit Apple Silicon bekommen eine native `.dmg`.

## Kann ich OpenScreen mit winget, Homebrew oder Flathub installieren? {#can-i-install-openscreen-with-winget-homebrew-or-flathub}

- **winget:** Ja, über die Store-Quelle: `winget install --source msstore OpenScreen`.
- **Homebrew:** Es gibt keinen offiziellen Cask. Stand September 2026 ist der Tap `siddharthvaddem/openscreen` des Originalprojekts noch auf Version 1.5.0 festgelegt. Nimm stattdessen die `.dmg` von der [Download-Seite](/download/).
- **Flathub:** Es gibt keinen Eintrag.

## Ist das das ursprüngliche OpenScreen-Projekt? {#is-this-the-original-openscreen-project}

**Es ist seine Fortführung.**

- Siddharth Vaddem hat OpenScreen entwickelt und das [ursprüngliche Repository](https://github.com/siddharthvaddem/openscreen) nach v1.5.0 archiviert.
- Die Entwicklung ist mit seiner Zustimmung nach [getopenscreen/openscreen](https://github.com/getopenscreen/openscreen) umgezogen, unter demselben Namen und derselben MIT-Lizenz.
- Die archivierte README nennt dieses Projekt einen Community-getragenen Ableger, geleitet von einem der Hauptbeitragenden. Das ist Etienne Lescot, der es pflegt. Der Link in der README, github.com/EtienneLescot/openscreen, leitet auf das aktuelle Repository weiter.
- Das archivierte Repository bekommt keine Updates mehr. [Picking up OpenScreen (auf Englisch)](/blog/2026/06/15/picking-up-openscreen/) erklärt die Übergabe.

## Hat OpenScreen etwas mit openscreen.io oder openscreen.net zu tun? {#is-openscreen-related-to-openscreenio-or-openscreennet}

- **openscreen.io:** Nein. Das ist ein anderes Produkt, Open Screen, das sich auf seiner Website als Bildschirmrekorder für macOS vorstellt. OpenScreen steht in keiner Verbindung dazu.
- **openscreen.net:** Das ist keine offizielle OpenScreen-Website.

## Was sind die offiziellen OpenScreen-Links? {#what-are-the-official-openscreen-links}

| Was | Link |
|---|---|
| Website | [getopenscreen.com](https://getopenscreen.com/) |
| Quellcode, Releases und Issues | [github.com/getopenscreen/openscreen](https://github.com/getopenscreen/openscreen) |
| Microsoft Store | [apps.microsoft.com/detail/9MXQ1HQJL5G5](https://apps.microsoft.com/detail/9MXQ1HQJL5G5) |
| Discord | [getopenscreen.com/discord](https://getopenscreen.com/discord/) |
| Originalprojekt, archiviert und schreibgeschützt | [github.com/siddharthvaddem/openscreen](https://github.com/siddharthvaddem/openscreen) |

## Was passiert, wenn eine Aufnahme abbricht? {#what-happens-if-a-recording-is-interrupted}

Unter Windows und macOS schreiben die nativen Rekorder fragmentiertes MP4 in Fragmenten von je einer Sekunde. Bricht eine Aufnahme ab, lässt sich die Datei bis zum letzten vollständigen Fragment abspielen.

Fehlerberichte und Feature-Wünsche gehören in die [GitHub-Issues](https://github.com/getopenscreen/openscreen/issues).

## Was kann OpenScreen nicht? {#what-doesnt-openscreen-do}

Wenn du eines davon brauchst, ist OpenScreen nicht das richtige Werkzeug:

- **Gehostetes Teilen.** Keine Freigabelinks, kein Cloudspeicher, keine Team-Arbeitsbereiche, keine Kommentare. Deine Dateien bleiben auf deiner Festplatte. Siehe [OpenScreen als Loom-Alternative](/alternatives/loom/).
- **Livestreaming.** Siehe [OpenScreen vs OBS Studio](/compare/openscreen-vs-obs/).
- **Untertiteldateien.** Untertitel werden ins Video eingebrannt. Es gibt keinen Export als SRT oder VTT. Siehe [Untertitel](./captions.md).
- **Mobilgeräte.** Keine Mobil-App und keine Aufnahme unter iOS oder Android.

## Wie fange ich an? {#how-do-i-get-started}

1. Hol dir den Installer für dein System von der [Download-Seite](/download/).
2. Folge der [Installation](./installation.md) für deine Plattform.
3. Nimm mit dem [Schnellstart](./quick-start.md) ein erstes Video auf, kürze und exportiere es.

## Quellen {#sources}

Geprüft im September 2026:

- Ursprüngliches Repository und sein Archivhinweis: [github.com/siddharthvaddem/openscreen](https://github.com/siddharthvaddem/openscreen)
- Homebrew-Tap des Originalprojekts: [github.com/siddharthvaddem/homebrew-openscreen](https://github.com/siddharthvaddem/homebrew-openscreen)
- Open Screen: [openscreen.io](https://openscreen.io/)

Open Screen, Loom, OBS Studio und die anderen Produktnamen auf dieser Seite sind Marken ihrer jeweiligen Inhaber. OpenScreen steht in keiner Verbindung zu Open Screen (openscreen.io), Loom oder OBS Studio.
