---
id: faq
title: "Preguntas frecuentes: licencia, privacidad y enlaces"
sidebar_label: Preguntas frecuentes
description: "¿OpenScreen es gratis para uso comercial? Sí, con licencia MIT. Marcas de agua, uso sin conexión, privacidad, instaladores firmados y enlaces oficiales."
keywords:
  - preguntas frecuentes de OpenScreen
  - gratis para uso comercial
  - licencia MIT
  - sin marca de agua
  - grabador de pantalla sin conexión
  - proyecto original de OpenScreen
---

# Preguntas frecuentes sobre OpenScreen

OpenScreen es un grabador de pantalla y editor de video gratis, con licencia MIT, para Windows, macOS y Linux. Es gratis para uso comercial, sin cuenta y sin marca de agua. Esta página responde a las preguntas que la gente se hace antes de instalarlo: la licencia, lo que pasa por la red, cómo están firmados los instaladores y qué sitios son oficiales. No es el mismo producto que Open Screen, de openscreen.io.

## ¿OpenScreen es gratis para uso comercial? {#is-openscreen-free-for-commercial-use}

**Sí.** OpenScreen se publica bajo la [licencia MIT](https://github.com/getopenscreen/openscreen/blob/main/LICENSE).

- Puedes usarlo, copiarlo, modificarlo, distribuirlo y venderlo. La única condición es conservar el aviso de copyright y de permiso en las copias del software.
- El texto de la licencia cubre el software. No dice nada sobre los videos que hagas con él.
- No hay cuenta, ni plan de pago, ni funciones premium.

## ¿OpenScreen agrega una marca de agua? {#does-openscreen-add-a-watermark}

**No.** Las exportaciones MP4 y GIF no llevan marca de agua, y no existe ninguna versión de pago que la quite. Consulta [Exportación](./export.md) para ver los formatos.

## ¿OpenScreen funciona sin conexión? {#does-openscreen-work-offline}

**La grabación, la transcripción y el renderizado se ejecutan en tu equipo.** OpenScreen no tiene ninguna función de subida, por lo que tus grabaciones se quedan en tu disco. Aun así, la app establece algunas conexiones de red, así que decir "totalmente sin conexión" sería incorrecto:

- **Google Fonts, en cada inicio.** La app carga desde los servidores de Google las fuentes de sus anotaciones de texto, incluido fonts.googleapis.com.
- **huggingface.co, una vez.** La primera transcripción descarga el modelo Whisper, de unos 264 MB, y lo verifica con un hash SHA-256. Después, la transcripción no necesita conexión.
- **github.com y api.github.com.** Las compilaciones que se actualizan solas buscan una nueva versión cada 24 horas, y cuando tú lo pides. De forma predeterminada, solo te avisan de que hay una disponible.
- **Tu proveedor de IA, solo si conectas uno.** La edición por chat envía tus mensajes y los datos del proyecto que lee, como la línea de tiempo y la transcripción. La traducción de subtítulos envía el texto de los subtítulos. Ambas permanecen desactivadas hasta que conectas un proveedor. Consulta [Edición con IA](./ai-editing.md).

## ¿OpenScreen recopila analíticas o informes de fallos? {#does-openscreen-collect-analytics-or-crash-reports}

**No.** El código de la app no contiene ningún SDK de analíticas ni de informes de fallos.

- No existe ningún servidor de OpenScreen al que la app pueda enviar informes.
- Las claves de los proveedores de IA se guardan cifradas con `safeStorage` de Electron. Si el cifrado no está disponible, la clave no se guarda.

## ¿Es seguro instalar OpenScreen? {#is-openscreen-safe-to-install}

**El código fuente es público, y las compilaciones de macOS y de la Store están firmadas.** Descarga solo desde los enlaces de [Enlaces oficiales](#what-are-the-official-openscreen-links).

- **macOS:** las compilaciones a partir de la 1.9.0 están firmadas con un Apple Developer ID y notarizadas.
- **Windows, Microsoft Store:** Microsoft firma el paquete, así que se instala sin advertencia.
- **Windows, instalador `.exe`:** no tiene firma de código. SmartScreen muestra "Windows protegió su PC". Elige **Más información** y luego **Ejecutar de todas formas**, o usa en su lugar la versión de la Store.

En [Instalación](./installation.md) están los pasos para cada plataforma.

## ¿En qué sistemas funciona OpenScreen? {#which-systems-does-openscreen-run-on}

| Sistema | Mínimo | Paquetes |
|---|---|---|
| macOS | 13 Ventura | `.dmg` para Apple Silicon y para Intel |
| Windows | 10 versión 1903, x64 | Microsoft Store, instalador `.exe` |
| Linux | x64, PipeWire y xdg-desktop-portal | AppImage, `.deb`, `.rpm`, `.pacman`, flake de Nix |

- En Windows, la captura nativa necesita la compilación 19041 (Windows 10 versión 2004). Las compilaciones anteriores recurren a la captura por navegador.
- Prevé 8 GB de RAM; se recomiendan 16 GB.

## ¿Hay una compilación ARM64 para Windows o Linux? {#is-there-an-arm64-build-for-windows-or-linux}

**No hay ninguna empaquetada.** Las versiones para Windows y Linux son solo x64.

- En Linux ARM64, el flake de Nix compila OpenScreen desde el código fuente para `aarch64-linux`.
- Los equipos Mac con Apple Silicon tienen un `.dmg` nativo.

## ¿Puedo instalar OpenScreen con winget, Homebrew o Flathub? {#can-i-install-openscreen-with-winget-homebrew-or-flathub}

- **winget:** sí, mediante el origen de la Store: `winget install --source msstore OpenScreen`.
- **Homebrew:** no hay ningún cask oficial. En septiembre de 2026, el tap `siddharthvaddem/openscreen` del proyecto original sigue fijado en la versión 1.5.0. Usa en su lugar el `.dmg` de la [página de descarga](/download/).
- **Flathub:** no hay ninguna ficha.

## ¿Es este el proyecto OpenScreen original? {#is-this-the-original-openscreen-project}

**Es su continuación.**

- Siddharth Vaddem creó OpenScreen y archivó el [repositorio original](https://github.com/siddharthvaddem/openscreen) después de la v1.5.0.
- El desarrollo pasó a [getopenscreen/openscreen](https://github.com/getopenscreen/openscreen) con su aprobación, con el mismo nombre y la misma licencia MIT.
- El README archivado describe este proyecto como un proyecto derivado impulsado por la comunidad y dirigido por uno de los colaboradores principales. Se trata de Etienne Lescot, que lo mantiene. El enlace del README, github.com/EtienneLescot/openscreen, redirige al repositorio actual.
- El repositorio archivado no recibe actualizaciones. La entrada del blog [Picking up OpenScreen (en inglés)](/blog/2026/06/15/picking-up-openscreen/) explica el traspaso.

## ¿OpenScreen tiene relación con openscreen.io u openscreen.net? {#is-openscreen-related-to-openscreenio-or-openscreennet}

- **openscreen.io:** no. Es otro producto, Open Screen, que su sitio presenta como un grabador de pantalla para macOS. OpenScreen no está afiliado a él.
- **openscreen.net:** no es un sitio oficial de OpenScreen.

## ¿Cuáles son los enlaces oficiales de OpenScreen? {#what-are-the-official-openscreen-links}

| Qué | Enlace |
|---|---|
| Sitio web | [getopenscreen.com](https://getopenscreen.com/) |
| Código fuente, versiones e incidencias | [github.com/getopenscreen/openscreen](https://github.com/getopenscreen/openscreen) |
| Microsoft Store | [apps.microsoft.com/detail/9MXQ1HQJL5G5](https://apps.microsoft.com/detail/9MXQ1HQJL5G5) |
| Discord | [getopenscreen.com/discord](https://getopenscreen.com/discord/) |
| Proyecto original, archivado y de solo lectura | [github.com/siddharthvaddem/openscreen](https://github.com/siddharthvaddem/openscreen) |

## ¿Qué pasa si una grabación se interrumpe? {#what-happens-if-a-recording-is-interrupted}

En Windows y macOS, los grabadores nativos escriben MP4 fragmentado, en fragmentos de un segundo. Si una grabación se interrumpe, el archivo sigue siendo reproducible hasta el último fragmento completo.

Los errores y las solicitudes de funciones se reportan en [GitHub Issues](https://github.com/getopenscreen/openscreen/issues).

## ¿Qué no hace OpenScreen? {#what-doesnt-openscreen-do}

Si necesitas algo de esto, OpenScreen no es la herramienta adecuada:

- **Compartir desde un servicio alojado.** No hay enlaces para compartir, almacenamiento en la nube, espacios de trabajo en equipo ni comentarios. Tus archivos se quedan en tu disco. Consulta [OpenScreen como alternativa a Loom](/alternatives/loom/).
- **Transmisión en vivo.** Consulta [OpenScreen vs. OBS Studio](/compare/openscreen-vs-obs/).
- **Archivos de subtítulos.** Los subtítulos se incrustan en el video. No hay exportación SRT ni VTT. Consulta [Subtítulos](./captions.md).
- **Dispositivos móviles.** No hay app móvil, ni captura en iOS o Android.

## ¿Cómo empiezo? {#how-do-i-get-started}

1. Descarga el instalador para tu sistema desde la [página de descarga](/download/).
2. Sigue [Instalación](./installation.md) para tu plataforma.
3. Graba, recorta y exporta un primer video con el [Inicio rápido](./quick-start.md).

## Fuentes {#sources}

Verificadas en septiembre de 2026:

- Repositorio original y su aviso de archivo: [github.com/siddharthvaddem/openscreen](https://github.com/siddharthvaddem/openscreen)
- Tap de Homebrew del proyecto original: [github.com/siddharthvaddem/homebrew-openscreen](https://github.com/siddharthvaddem/homebrew-openscreen)
- Open Screen: [openscreen.io](https://openscreen.io/)

Open Screen, Loom, OBS Studio y los demás nombres de productos de esta página son marcas comerciales de sus respectivos propietarios. OpenScreen no está afiliado a Open Screen (openscreen.io), Loom ni OBS Studio.
