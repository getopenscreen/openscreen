---
id: media-library
title: Biblioteca multimedia y clips
sidebar_position: 5
description: "Administra fuentes y clips en OpenScreen: importa videos; recorta, encuadra, divide y reordena clips en una línea de tiempo, y define el tamaño de salida."
keywords:
  - biblioteca multimedia
  - clips de video
  - recortar video
  - encuadrar video
  - dividir clips
  - línea de tiempo
---

# Biblioteca multimedia y clips

Un proyecto no es una sola grabación: es un conjunto de fuentes y una lista ordenada de clips cortados a partir de ellas. El modo **Multimedia** es donde administras las fuentes; la fila de clips de la parte inferior de la línea de tiempo es donde las organizas.

## Modo Multimedia {#media-mode}

Cambia a **Multimedia** en la barra superior. La vista muestra una tarjeta por cada fuente del proyecto, con un cuadro de búsqueda encima.

Selecciona una tarjeta para abrir su panel de detalles:

- **Transcripción de la fuente**: el texto completo de ese recurso, con su estado (Sin transcripción / Transcripción pendiente / Descargando modelo de voz / Iniciando el modelo de voz / Transcribiendo / Transcripción lista / No se detectó voz / Sin pista de audio / Error de transcripción) y el idioma detectado.
- **Regenerar en**: vuelve a ejecutar Whisper localmente para este recurso, ya sea con detección **Auto** o forzando uno de los 100 idiomas que admite Whisper.

**Importar contenido** agrega un video desde el disco. El cuadro de diálogo de archivos acepta `webm`, `mp4`, `mov`, `avi`, `mkv`, `m4v`, `wmv`, `flv` y `ts`. Esta vista solo admite video: la música y otros archivos de audio se agregan desde el menú **Añadir audio** de la barra de herramientas de la línea de tiempo, y las imágenes, como [anotaciones de imagen](./editing-timeline.md#annotations).

Importar una fuente *no* la pone en la línea de tiempo. Para eso, arrastra su tarjeta a la fila de clips.

## Clips en la línea de tiempo {#clips-on-the-timeline}

La fila inferior de la línea de tiempo es la tira de clips. Cada clip muestra su propia forma de onda.

- **Arrastra para reordenar.** Las regiones de arriba siguen a su clip: un zoom que colocaste en un clip se queda en ese clip cuando lo mueves.
- **Doble clic** (o el lápiz de un clip) abre **Editar clip**: puntos de entrada y salida con un rango que puedes recorrer, y un rectángulo de recorte con controles arrastrables, campos numéricos X/Y/A/Al y proporciones predefinidas. El recorte de imagen es por clip.
- **Eliminar clip** lo quita de la línea de tiempo; la fuente permanece en la biblioteca multimedia.
- **Suelta una fuente sobre un clip existente** y OpenScreen te pregunta dónde colocarla: **Añadir antes**, **Añadir después** o **Dividir aquí e insertar**, que corta el clip de destino en el punto donde la soltaste e inserta la nueva fuente en medio.

Los clips siempre son contiguos: sin huecos ni superposiciones. Al quitar o reordenar uno, la regla se reajusta para cerrar el hueco.

## Tamaño de salida {#output-size}

El control **Formato** del panel **Composición** define la forma del cuadro; **Original** muestra las formas reales de los clips de tu proyecto. Cada clip se ajusta dentro de ese cuadro, así que funciona mezclar en una misma línea de tiempo una grabación de pantalla 16:9 con una captura de teléfono 9:16. Consulta [Exportación](./export.md#resolution) para saber qué resolución se obtiene.

## Empezar un proyecto {#starting-a-project}

**Nuevo proyecto** pide un nombre y un punto de partida:

- **Grabación de pantalla**: pasa directamente al [modo Grabar](./recording.md#recording-from-the-editor-rec-mode).
- **Importar contenido**: abre el selector de archivos.

**Abrir proyecto** muestra tus archivos `.openscreen` recientes con un cuadro de búsqueda, navegación con el teclado y, como alternativa, **Explorar archivos…**. También puedes soltar un archivo `.openscreen` en el editor vacío.
