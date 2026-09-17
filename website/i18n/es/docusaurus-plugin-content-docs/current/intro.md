---
id: intro
title: "Documentación: instalar, grabar, editar y exportar"
sidebar_label: Introducción
sidebar_position: 1
description: "Documentación de OpenScreen 1.11.0, grabador de pantalla y editor con licencia MIT: instálalo, graba, edita, subtitula y exporta en Windows, macOS y Linux."
keywords:
  - grabador de pantalla
  - grabador de pantalla de código abierto
  - grabador de pantalla gratis
  - editor de video
  - documentación de OpenScreen
  - Windows
  - macOS
  - Linux
---

# Documentación de OpenScreen: instalar, grabar, editar, exportar

OpenScreen es un **grabador de pantalla y editor gratis y de código abierto**. Graba a través de la API de captura nativa de cada plataforma (ScreenCaptureKit en macOS, Windows Graphics Capture en Windows, PipeWire mediante el portal ScreenCast en Linux), y compone tanto la vista previa en vivo como la exportación final en la GPU con un renderizador nativo escrito en Rust (Direct3D 11 en Windows, Metal en macOS, wgpu en Linux). Es una sola ruta, así que lo que ves en el editor es lo que sale en la exportación.

Estas páginas describen **OpenScreen 1.11.0**, la versión estable del 9 de septiembre de 2026. Qué cambió en cada versión, y por qué, está en el [diario de desarrollo (en inglés)](/blog/).

:::note
OpenScreen publica versiones con frecuencia. De una versión a otra, el formato de proyecto `.openscreen` y la [CLI](/docs/cli/) todavía pueden cambiar.
:::

## Lo que puedes hacer {#what-you-can-do}

- [Grabar](./recording.md) una ventana específica o toda la pantalla, con audio del sistema, micrófono y cámara web, desde un HUD flotante o desde el propio editor.
- Armar un proyecto con varias fuentes: [importar, recortar, encuadrar, reordenar y dividir clips](./media-library.md) en una sola línea de tiempo.
- [Editar](./editing-timeline.md) con zooms, recortes, velocidad por región, segmentos de cámara a pantalla completa, anotaciones de texto, imagen, flecha y desenfoque, temas de cursor, disposiciones de la cámara web, y fondo y efectos.
- Transcribir en tu equipo con Whisper y luego [incrustar subtítulos](./captions.md), con un estilo que se ajusta en vivo y traducibles a 15 idiomas mediante tu propio proveedor de LLM, o cortar tu grabación borrando palabras de la transcripción.
- Conectar, si quieres, tu propia clave de LLM para [editar por chat](./ai-editing.md): desactivado por defecto y nunca obligatorio.
- [Exportar](./export.md) a MP4 (720p/1080p/Source, H.264 o H.265) o a GIF animado.

Las preguntas sobre la licencia, las marcas de agua o lo que pasa por la red se responden en las [preguntas frecuentes](/docs/faq/). Cómo se compara OpenScreen con otros grabadores se explica en las páginas sobre [Screen Studio](/alternatives/screen-studio/), [Cap](/compare/openscreen-vs-cap/) y [OBS Studio](/compare/openscreen-vs-obs/).

:::note
La grabación, la edición, la transcripción, los subtítulos y la exportación no necesitan cuenta y siguen funcionando sin conexión a la red. La transcripción requiere antes una descarga: su modelo Whisper (~264 MB), que se obtiene la primera vez que la usas. Cuando hay conexión, la app también carga al iniciarse las fuentes de sus anotaciones desde Google Fonts, y las compilaciones instaladas desde GitHub Releases consultan GitHub en busca de actualizaciones. La edición por chat con IA y la traducción de subtítulos solo se conectan a internet cuando tú mismo conectas un proveedor, y solo con ese proveedor.
:::

## Datos del proyecto {#project-facts}

| | |
|---|---|
| **Licencia** | MIT: gratis para uso personal y comercial |
| **Versión documentada** | 1.11.0 ([todas las versiones](https://github.com/getopenscreen/openscreen/releases)) |
| **Plataformas** | Windows 10 versión 1903 o posterior (x64), macOS 13 o posterior (Apple Silicon e Intel), Linux (paquetes x64; aarch64 mediante el flake de Nix). Consulta [Instalación](./installation.md) |
| **Origen** | Creado por Siddharth Vaddem, que [archivó el repositorio original](https://github.com/siddharthvaddem/openscreen) después de la v1.5.0. El desarrollo continúa aquí con su aprobación, con el mismo nombre y la misma licencia MIT. |

## Enlaces oficiales {#official-links}

| | |
|---|---|
| **Sitio web** | [getopenscreen.com](https://getopenscreen.com/) |
| **Código fuente, versiones, incidencias** | [github.com/getopenscreen/openscreen](https://github.com/getopenscreen/openscreen) |
| **Microsoft Store** | [apps.microsoft.com/detail/9MXQ1HQJL5G5](https://apps.microsoft.com/detail/9MXQ1HQJL5G5) |
| **Discord** | [getopenscreen.com/discord](https://getopenscreen.com/discord/) |

## Estado de este sitio {#status-of-this-site}

Todo lo que está en **Funciones** en la barra lateral documenta lo que la app incluye realmente hoy, no la hoja de ruta. Las especificaciones internas más detalladas en las que se basa este sitio (notas de arquitectura, documentación de ingeniería, planes de prueba) siguen en el repositorio, en inglés, y todavía no se han migrado aquí:

- [`README.md`](https://github.com/getopenscreen/openscreen/blob/main/README.md)
- [`CONTRIBUTING.md`](https://github.com/getopenscreen/openscreen/blob/main/CONTRIBUTING.md)
- [`AGENTS.md`](https://github.com/getopenscreen/openscreen/blob/main/AGENTS.md)
- [`docs/`](https://github.com/getopenscreen/openscreen/tree/main/docs)
