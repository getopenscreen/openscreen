---
id: captions
title: Subtítulos y transcripción
sidebar_position: 7
description: "Transcribe en local con Whisper (100 idiomas), incrusta subtítulos con estilo, tradúcelos con tu propia clave de LLM y corta la grabación borrando palabras."
keywords:
  - subtítulos automáticos
  - subtitular video
  - transcripción con Whisper
  - transcripción sin conexión
  - traducir subtítulos
  - editar video desde la transcripción
---

# Subtítulos y transcripción

OpenScreen transcribe el audio de tu grabación **completamente en tu equipo**: tu audio nunca se sube, y una vez que el modelo está en el disco, funciona sin conexión. Esa única transcripción sirve luego de fuente para dos cosas: los subtítulos incrustados en tu video y una vista de texto desde la que puedes editar tu grabación.

## Transcribir {#transcribing}

Cada clip tiene su propia transcripción. Puedes generarla de dos maneras:

- Desde la vista **Multimedia**: selecciona la tarjeta de un recurso y haz clic en **Regenerar**. Aquí también puedes forzar uno de los 100 idiomas de Whisper en **Regenerar en**, en lugar de dejarlo en detección **Auto**, y aquí se ve el estado de cada recurso (Transcripción pendiente, Transcribiendo, Transcripción lista, Error de transcripción y los demás que se enumeran en [Biblioteca multimedia](./media-library.md#media-mode)).
- Desde el panel **Transcripción** del inspector del editor: **Transcribir ahora** ejecuta el mismo proceso sobre el contenido actual.

El motor whisper.cpp viene incluido en la app; el modelo no. La primera vez se descarga desde huggingface.co (~264 MB, verificado con SHA-256 y escrito de forma atómica para que nunca se use una descarga a medias): es el único momento en que la transcripción necesita red. Después funciona totalmente sin conexión, con un backend que se elige en tiempo de ejecución: Metal en Apple Silicon, Vulkan en Windows y Linux con respaldo en CPU, y CPU en los equipos Mac con Intel.

Los tiempos de cada palabra salen de las marcas de tiempo DTW que el propio Whisper asigna a los tokens, y luego se vuelven a anclar en el audio mismo: cada límite se desplaza hacia atrás, al momento más silencioso justo antes de él. Por eso un corte hecho desde la transcripción cae donde realmente empieza la palabra y no una sílaba más tarde.

## Subtítulos {#captions}

Los subtítulos son una **vista en vivo de la transcripción**, no un texto generado que luego tienes que mantener. Si cambias la transcripción, cambias los ajustes de los subtítulos o mueves clips en la línea de tiempo, los subtítulos se actualizan en el siguiente fotograma: no hay paso de regeneración ni copias desactualizadas que conciliar.

En el panel **Transcripción** del inspector, haz clic en **Subtítulos**:

| Sección | Controles |
|---|---|
| **Mostrar subtítulos** | Interruptor general para la vista previa y la exportación. |
| **Idioma** | *Original (transcripción)* o cualquier capa de traducción que hayas generado. |
| **Texto** | Fuente, tamaño, negrita, color del texto. |
| **Fondo** | Activar/desactivar, color y opacidad de la placa que hay detrás del texto. |
| **Posición** | **Abajo** o **Arriba**, con la distancia desde ese borde (0–50 % del cuadro); **Izquierda**, **Centro** o **Derecha**, con la distancia desde ese lado (0–25 %, ninguna para Centro). |
| **Longitud de línea** | Mínimo y máximo de palabras por línea (1–12). Las líneas se llenan dentro de ese rango. |

Todo lo de **Posición** se mide respecto al **cuadro exportado**, no respecto al video que contiene. Los subtítulos se quedan donde los pusiste cuando cambias el relleno, y pueden quedar sobre el área de relleno: pon la distancia vertical en 0 y el texto queda pegado al borde superior o inferior del cuadro. Los subtítulos largos crecen alejándose del borde al que están anclados: uno anclado abajo crece hacia arriba, y uno anclado arriba crece hacia abajo.

El tamaño se expresa en píxeles sobre un cuadro de 1080 píxeles de alto y se escala con la salida real, así que los subtítulos se ven igual en 720p, en 1080p o a la resolución de origen. La vista previa y la exportación comparten el mismo código de diseño: lo que ves es lo que se incrusta. Los subtítulos solo existen incrustados: OpenScreen no escribe ningún archivo `.srt` ni `.vtt` aparte, así que quien vea el archivo no puede desactivarlos. La [comparativa de subtítulos locales](/features/captions/) menciona grabadores que sí escriben un archivo de subtítulos.

### Traducción {#translation}

Elige un idioma de destino y haz clic en **Traducir**. El menú desplegable incluye quince idiomas de destino: inglés, francés, español, alemán, italiano, portugués, neerlandés, polaco, turco, ruso, árabe, hindi, japonés, coreano y chino.

La traducción pasa por el proveedor de LLM que hayas conectado (consulta [Edición con IA](./ai-editing.md)): es la única función de subtítulos que necesita red. Se guarda **junto a** la transcripción, nunca dentro de ella: el texto original y sus tiempos no se tocan, puedes volver a *Original* en cualquier momento, y eliminar una traducción deja la grabación exactamente como estaba. Volver a traducir después de agregar material solo cuesta el material nuevo, y lo que el modelo no devuelva se queda con las palabras originales en lugar de inventarse.

:::note
Los proyectos creados con el antiguo flujo de "generar subtítulos" guardan el texto de los subtítulos como anotaciones reales, que se dibujarían encima de la capa en vivo. El panel Subtítulos las detecta y ofrece quitarlas; antes pregunta, porque elimina datos.
:::

## Edición de la transcripción {#transcript-editing}

El panel **Transcripción** muestra la transcripción conjunta de todos los clips de la línea de tiempo. Es una vista de texto en vivo de tu grabación:

- Selecciona una palabra o un rango de palabras y presiona `Backspace`/`Delete` para marcar ese tramo como omitido: se elimina de la reproducción y de la exportación, exactamente como una región de recorte en la línea de tiempo, solo que desde el texto.
- Los tramos omitidos aparecen tachados en rojo. Pasa el mouse sobre uno para restaurarlo.
- Los silencios aparecen marcados dentro del texto y se pueden recortar o restaurar de la misma forma.

Sin subidas ni nube: todo se hace sobre la transcripción que ya está en tu proyecto.
