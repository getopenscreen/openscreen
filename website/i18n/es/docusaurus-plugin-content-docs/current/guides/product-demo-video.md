---
id: product-demo-video
title: Cómo hacer un video de demostración de producto
sidebar_label: Video de demostración
description: "Cómo hacer un video demo de producto con OpenScreen: guion, grabación a 60 fps, cámara web, zooms automáticos, cortes, desenfoque, subtítulos y exportación."
keywords:
  - video de demostración de producto
  - cómo grabar una demo de software
  - video demo con zoom y subtítulos
  - tutorial para grabar la pantalla
  - teleprompter
---

# Cómo hacer un video de demostración de producto

Para hacer un video de demostración de producto, escribe un guion corto, graba el producto a un ritmo constante y luego edita: corta los tiempos muertos, haz zoom en lo importante, oculta los datos privados, agrega subtítulos y exporta en la proporción que necesite tu canal. Esta guía recorre cada paso con OpenScreen, un grabador de pantalla y editor gratis, con licencia MIT, para Windows, macOS y Linux, donde la grabación, la edición, la transcripción y la exportación se ejecutan en tu equipo. OpenScreen produce un archivo de video. No aloja el video ni crea un recorrido interactivo en el que se pueda hacer clic; si necesitas alguna de las dos cosas, consulta [Cuándo OpenScreen no es la herramienta adecuada](#when-openscreen-is-not-the-right-tool).

## Antes de empezar {#before-you-start}

- Instala OpenScreen desde la [página de descarga](/download/). [Instalación](../installation.md) cubre cada plataforma.
- Decide dónde se verá el video. Eso determina la proporción: 16:9 para un sitio web o una página de documentación, 9:16 para un feed vertical, 1:1 para un espacio cuadrado.
- Prepara el producto: una cuenta de demostración, datos de ejemplo, notificaciones desactivadas.

## 1. Escribe el guion en la ventana de notas {#1-write-the-script-in-the-notes-window}

En Windows y macOS, haz clic en **Abrir notas** en el HUD. Se abre una ventana de texto enriquecido que se guarda localmente entre sesiones. Escribe ahí el guion, una acción por línea. El HUD de Linux no tiene el botón de notas.

La ventana de notas también sirve de teleprompter. **Iniciar desplazamiento automático** desplaza el texto a una velocidad de 10 a 100. El tamaño de fuente va de 14 a 48 px, y **Reflejar horizontalmente** invierte el texto.

:::caution
En Windows, OpenScreen deja el HUD y la ventana de notas fuera de la captura. En macOS no puede garantizarlo, así que mantén la ventana de notas en una pantalla que no estés grabando. En macOS y Linux, usa **Ocultar HUD** si el HUD está en la pantalla que grabas.
:::

## 2. Graba la pantalla o una ventana {#2-record-the-screen-or-a-window}

1. En Windows y macOS, abre el selector de fuente y elige una pantalla en **Pantallas** o una sola ventana en **Ventanas**. En Linux no hay selector dentro de la app: el portal del sistema pide la fuente en cada toma. OpenScreen no tiene captura de región, así que graba la ventana o la pantalla y luego encuadra el clip en el editor.
2. Activa el micrófono y revisa su medidor de nivel. Activa el audio del sistema si el producto emite sonido, y la cámara web si quieres aparecer en pantalla.
3. Mantén el modo de cursor editable, el predeterminado: el puntero se graba como datos, así que puedes cambiar su estilo después. En Windows se graban los clics. En macOS, los clics necesitan el permiso de Accesibilidad. En Linux, tu usuario debe estar en el grupo `input`, y la función de tocar para hacer clic del touchpad no se captura ([detalles](../installation.md#mouse-clicks-on-wayland)).
4. Presiona grabar. Primero aparece una cuenta regresiva 3-2-1, que no se puede desactivar.

OpenScreen captura con un objetivo de 60 fps, hasta 3840×2160 en Windows y macOS. En Linux, el tamaño es el que entregue el compositor. Mientras grabas puedes pausar, reiniciar la toma, cancelarla o detener la grabación.

**Ritmo pensado para los zooms.** Mueve el puntero hacia lo que vas a explicar y luego déjalo quieto. Los zooms automáticos del paso 4 buscan esas pausas: un puntero quieto entre aproximadamente medio segundo y 2.6 segundos. Un puntero que se queda quieto más tiempo no recibe zoom.

**Demos largas en Linux.** Linux escribe un MP4 normal que solo se finaliza cuando detienes la grabación, así que un cierre inesperado a mitad de la toma deja un archivo ilegible. Mejor graba varias tomas más cortas; el paso 5 muestra cómo unirlas.

Consulta [Grabación](../recording.md) para ver todos los controles del HUD.

## 3. Elige la disposición de la cámara web y el fondo {#3-choose-the-webcam-layout-and-background}

La cámara web se graba en su propio archivo, así que su ubicación es una decisión de edición que puedes cambiar en cualquier momento. Abre el panel **Disposición de cámara** en el inspector del editor:

- **Imagen en imagen**, **Apilado vertical**, **Marco dual** o **Sin cámara**.
- En todas las disposiciones: reflejo y un encuadre de la imagen de la cámara.
- Solo en **Imagen en imagen**: **Forma de cámara** (Rect., Círculo, Cuadrado o Redondeado), un tamaño del 10 al 50 % (25 % por defecto) y **Reducir al ampliar**, activado por defecto, que hace más pequeña la cámara mientras se reproduce un zoom para que no tape el detalle. Arrastra la cámara sobre el lienzo para moverla.
- **Fondo de la cámara**: Original, Desenfocado, Recortado o Personalizado. Recortado quita el fondo sin pantalla verde, con un modelo de segmentación que se ejecuta en tu CPU. Esta sección solo aparece cuando el entorno de ejecución de segmentación se carga en tu equipo.

Para una introducción o un cierre, presiona `C` para agregar un segmento de **Cámara a pantalla completa**: la cámara llena todo el cuadro durante ese tramo.

El panel **Composición** da estilo al cuadro. Su sección de fondo ofrece 18 fondos de pantalla incluidos, un color sólido, un degradado o tu propia imagen, y un desenfoque de fondo. Debajo están la sombra, la redondez, el relleno y el desenfoque de movimiento.

## 4. Agrega zooms automáticos {#4-add-automatic-zooms}

En la barra de herramientas de la línea de tiempo, abre **Mejora automática** y elige **Zooms automáticos**. OpenScreen lee el movimiento grabado del cursor y coloca regiones de zoom en esas pausas, sin red y sin modelo. Si no coloca nada, te lo indica. Las causas habituales son una grabación sin datos del cursor, la ausencia de pausas en ese rango o zooms existentes que ya cubren esos momentos.

Luego revísalos. Haz clic en un zoom para definir su nivel (de 1.25× a 5×), su modo de enfoque (Auto sigue al cursor, Manual mantiene un punto fijo) y una rotación 3D opcional. Presiona `Z` para agregar un zoom a mano, y `Ctrl/Cmd+D` para eliminar uno que no quieras.

Más información sobre cómo se colocan los zooms: [Zoom automático](/features/auto-zoom/).

## 5. Corta desde la transcripción y acelera los tiempos muertos {#5-cut-from-the-transcript-and-speed-up-dead-time}

**Primero, transcribe.** Abre el panel **Transcripción**. Si todavía no hay transcripción, haz clic en **Transcribir ahora**. La transcripción se ejecuta localmente con Whisper. La primera ejecución descarga su modelo una sola vez, unos 264 MB.

**Corta desde el texto.** En la transcripción, selecciona palabras y presiona `Delete`: ese tramo se elimina de la reproducción y de la exportación. Los silencios aparecen en el texto como marcadores: haz clic en uno para cortarlo, y vuelve a hacer clic para restaurarlo. Pasa el mouse sobre una palabra cortada para restaurarla. También puedes presionar `T` para agregar una región de recorte en la línea de tiempo.

**Acelera lo que no puedas cortar**, como las cargas de página o el tecleo. Presiona `S` para agregar una región de velocidad, elige un valor predefinido de 0.25× a 5× o escribe cualquier valor de 0.1× a 100×. El audio se estira en el tiempo para acompañar la nueva velocidad.

**Une varias tomas.** Cambia a **Multimedia**, usa **Importar contenido** si una toma todavía no aparece y luego arrastra su tarjeta a la fila de clips. Si la sueltas sobre un clip existente, se ofrecen **Añadir antes**, **Añadir después** o **Dividir aquí e insertar**. Consulta [Biblioteca multimedia](../media-library.md).

Si conectaste tu propio proveedor de LLM, **Mejora automática → Cortes inteligentes** le encarga los cortes al agente de IA. Es opcional y está desactivado hasta que agregues una clave ([Edición con IA](../ai-editing.md)). Deshacer conserva los últimos 50 pasos, incluidas las ediciones del agente.

## 6. Desenfoca los datos privados, anota y agrega sonido {#6-blur-private-data-annotate-add-sound}

Presiona `A` para agregar una anotación y luego elige su **Tipo**:

- **Desenfoque**: Gaussiano o Mosaico, rectángulo u óvalo. Colócalo sobre correos electrónicos, claves API o nombres de clientes, extiende su región a todos los fotogramas en que aparecen y luego recorre el video para comprobarlo.
- **Texto**: con una animación opcional (Desvanecimiento, Ascender, Aparecer, Deslizar izquierda, Máquina de escribir o Pulso).
- **Flecha**: ocho direcciones, con grosor del trazo y color ajustables.
- **Imagen**: un JPG, PNG, GIF o WebP, como un logotipo.

Para el sonido, presiona `V` para grabar una voz en off en la línea de tiempo, o `M` para importar música (mp3, wav, m4a, aac, flac, ogg, opus). Cada pista tiene su propia ganancia, fundidos, bucle y opción de silenciar.

El panel **Cursor** cambia el estilo del puntero grabado en el paso 2. Todas las herramientas se describen en [Edición y línea de tiempo](../editing-timeline.md).

## 7. Incrusta los subtítulos {#7-burn-in-captions}

En el panel **Transcripción**, haz clic en **Subtítulos** y activa **Mostrar subtítulos**. Se dibujan en vivo a partir de la transcripción, así que los cortes del paso 5 se aplican sin ningún paso extra. Define la fuente, el tamaño, la negrita, el color, la placa de fondo, la posición y de 1 a 12 palabras por línea. Revisa la ubicación en la vista previa después de cualquier cambio de proporción.

Whisper detecta el idioma hablado, o puedes forzar uno de los 100 idiomas con **Regenerar en** en la vista Multimedia. Para publicar en otro idioma, usa **Traducir** hacia uno de los 15 idiomas de destino y selecciona ese idioma en **Visualización** antes de exportar. La traducción pasa por tu propio proveedor de LLM, así que necesita una clave.

Los subtítulos se incrustan en el video. OpenScreen no escribe ningún archivo `.srt` ni `.vtt`, así que un reproductor no puede desactivarlos. Detalles: [Subtítulos y transcripción](../captions.md) y [cómo funciona la función de subtítulos](/features/captions/).

## 8. Exporta {#8-export}

**Elige la proporción.** El control **Formato** del panel **Composición** ofrece 16:9 (la predeterminada), 9:16, 1:1, 4:3, 4:5, 16:10, 10:16 o la forma original de tus clips.

**Exporta.** Haz clic en **Exportar** en la barra superior:

- **MP4**: 720p, 1080p o Source; 24, 30 o 60 fps; H.264 o H.265. El cuadro de diálogo marca H.264 como la opción de mejor compatibilidad. La tasa de bits del video no se puede ajustar: ronda los 8 Mbit/s en 1080p.
- **GIF**: 15, 20, 25 o 30 fps; tamaño Medium, Large u Original; bucle activado o desactivado. Los GIF usan 256 colores sin tramado, así que funcionan bien para clips cortos de interfaces planas.

No hay marca de agua. Para exportar en otra proporción, cambia el formato y vuelve a exportar.

**Conserva el proyecto.** Guárdalo con `Ctrl/Cmd+S` como archivo `.openscreen`, para poder cambiar un clip y volver a exportar cuando cambie la interfaz. El proyecto hace referencia a tus archivos multimedia en lugar de incluirlos; `openscreen pack` lo reúne todo en una sola carpeta portátil ([CLI](/docs/cli/)). Más información en [Exportación](../export.md).

## Publica el archivo {#publish-the-file}

OpenScreen no aloja tu video, no crea enlaces para compartir ni cuenta reproducciones. Sube el archivo exportado adonde tu audiencia lo vaya a ver.

## Cuándo OpenScreen no es la herramienta adecuada {#when-openscreen-is-not-the-right-tool}

- **Quieres un enlace alojado con estadísticas de espectadores o comentarios.** Te conviene más un grabador con alojamiento. Loom, por ejemplo, comparte cada grabación como un enlace en loom.com, y su página de precios incluye estadísticas de espectadores y comentarios en los videos en todos los planes (en septiembre de 2026). Consulta [OpenScreen como alternativa a Loom](/alternatives/loom/) para el caso, más acotado, en que OpenScreen sí encaja.
- **Quieres una demo interactiva** en la que el espectador haga clic. OpenScreen solo exporta video y GIF.
- **Tu reproductor de video necesita un archivo de subtítulos aparte.** OpenScreen solo incrusta los subtítulos.
- **Grabas en un teléfono o una tableta.** OpenScreen es una app de escritorio para Windows, macOS 13 o posterior, y Linux.

## Fuentes {#sources}

- OpenScreen: el [código fuente de la versión v1.11.0](https://github.com/getopenscreen/openscreen/tree/v1.11.0).
- Loom: [loom.com](https://www.loom.com) y [loom.com/pricing](https://www.loom.com/pricing), consultados en septiembre de 2026.

Loom es una marca comercial de su propietario. OpenScreen no está afiliado a Loom.
