---
id: quick-start
title: Cómo grabar tu pantalla con OpenScreen
sidebar_label: Inicio rápido
sidebar_position: 3
description: "Graba, recorta y exporta tu primera grabación de pantalla con OpenScreen en seis pasos, desde abrir el HUD hasta exportar un MP4 o GIF terminado."
keywords:
  - tutorial para grabar la pantalla
  - inicio rápido
  - grabar pantalla
  - recortar video
  - exportar a MP4
---

# Cómo grabar tu pantalla con OpenScreen

Este inicio rápido explica cómo grabar, recortar y exportar tu primer video. Si todavía no tienes OpenScreen instalado, consulta primero [Instalación](./installation.md).

## 1. Abre el HUD de grabación {#1-open-the-recording-hud}

Al iniciar OpenScreen aparece una pequeña píldora flotante (el HUD) acoplada en la parte inferior de la pantalla. Se mantiene por encima de todo y no intercepta los clics hasta que interactúas con ella.

## 2. Elige qué grabar {#2-pick-what-to-record}

Haz clic en el selector de fuente (ícono de pantalla) para abrir la ventana de selección de fuentes. Muestra tus **Pantallas** y **Ventanas** en dos pestañas: elige una miniatura y haz clic en **Compartir**.

En Linux, el HUD no tiene selector de fuente. Muestra *El sistema te preguntará qué compartir*: cuando presionas grabar, el propio cuadro de diálogo para compartir de tu escritorio te pide la pantalla o la ventana, antes de la cuenta regresiva y otra vez en cada toma.

## 3. Activa el audio y la cámara web (opcional) {#3-turn-on-audio-and-webcam-optional}

En el grupo de audio del HUD, activa o desactiva:
- **Audio del sistema**: captura lo que se reproduce en tu equipo.
- **Micrófono**: abre un medidor de nivel y un selector de dispositivo para que confirmes que está seleccionado el micrófono correcto.
- **Cámara web**: abre un selector de cámara; la cámara web se graba como una pista aparte que colocarás después en el editor.

## 4. Graba {#4-record}

Haz clic en el botón de grabar. Aparece una cuenta regresiva 3‑2‑1 sobre tu escritorio y luego empieza la grabación. Mientras grabas puedes:
- **Pausar grabación / Reanudar grabación**
- **Reiniciar grabación**: descarta la toma actual y empieza de nuevo
- **Cancelar grabación**: descarta sin guardar

Haz clic en **Detener** cuando termines.

## 5. Abre el Studio {#5-open-the-studio}

Haz clic en **Abrir Studio** (o se abre automáticamente al detener la grabación) para cargar tu grabación en el editor.

## 6. Recorta y exporta {#6-trim-and-export}

- Coloca el cabezal de reproducción donde quieras un corte y presiona `T` (o el botón de las tijeras): ahí aparece una región de recorte de dos segundos. Arrastra sus bordes para ajustar lo que se elimina.
- Haz clic en **Exportar** en la barra superior, elige **MP4** o **GIF**, elige una calidad y haz clic en **Exportar**.
- Cuando termine, haz clic en **Mostrar en la carpeta** para encontrar tu archivo.

Ese es el ciclo básico. Para ver todas las herramientas de edición (zooms, cambios de velocidad, anotaciones, estilo del cursor, disposición de la cámara web), consulta [Edición y línea de tiempo](./editing-timeline.md). Para unir varias tomas en un solo video, consulta [Biblioteca multimedia](./media-library.md).

:::note
La barra superior cambia el editor entre tres modos: **Multimedia** (tus clips), **Editar** (todo lo anterior) y **Grabar** (preparar la siguiente grabación sin salir de la app).
:::

:::tip
Guarda tu trabajo como proyecto (`⌘/Ctrl S`) antes de exportar si quieres volver y seguir editando más tarde: los archivos de proyecto `.openscreen` mantienen editables todas las capas, a diferencia del video exportado.
:::
