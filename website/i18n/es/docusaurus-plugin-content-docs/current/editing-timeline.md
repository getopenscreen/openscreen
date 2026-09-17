---
id: editing-timeline
title: Edición y línea de tiempo
sidebar_position: 6
description: "Edita en la línea de tiempo de OpenScreen: regiones de zoom, recorte y velocidad, cámara a pantalla completa, anotaciones, cursor e inspector flotante."
keywords:
  - editor de video con línea de tiempo
  - regiones de zoom
  - rampas de velocidad
  - anotaciones
  - suavizado del cursor
  - edición multipista
---

# Edición y línea de tiempo

El editor tiene tres modos, que se cambian desde el control segmentado de la barra superior:

| Modo | Para qué sirve |
|---|---|
| **Multimedia** | Los clips de tu proyecto: importar, buscar, revisar transcripciones, arrastrarlos a la línea de tiempo. Consulta [Biblioteca multimedia](./media-library.md). |
| **Editar** | La vista previa, el inspector flotante y la línea de tiempo completa. Aquí es donde realmente se edita el proyecto. |
| **Grabar** | Configuración previa de una nueva grabación: micrófono, cámara, audio del sistema, cursor. Consulta [Grabación](./recording.md#recording-from-the-editor-rec-mode). |

Todo lo que sigue describe el modo **Editar**: una vista previa redimensionable arriba y la línea de tiempo debajo. Arrastra el control que hay entre ambas para cambiar la proporción.

## Inspector flotante {#floating-inspector}

Sobre la vista previa hay una barra flotante de íconos con cinco paneles:

| Panel | Qué controla |
|---|---|
| **Composición** | Una sección de fondo (imagen, color sólido o degradado detrás de tu grabación; sube tu propia imagen o elige un preajuste) y luego desenfoque de fondo, sombra, desenfoque de movimiento, redondez de las esquinas y relleno. Su fila **Formato** define la forma de salida para la vista previa y la exportación: las formas propias de tus clips en **Original**, más 16:9, 9:16, 1:1, 4:3, 4:5, 16:10 y 10:16. |
| **Disposición de cámara** | Composición de la cámara web: imagen en imagen, apilado vertical, marco dual o sin cámara. Reflejo, "reducir al ampliar", forma de la cámara (rectángulo/círculo/cuadrado/redondeado) y tamaño. Arrastra la burbuja de la cámara web directamente sobre el lienzo para cambiarla de lugar. |
| **Audio** | El nivel de salida, que se aplica igual en la vista previa y en la exportación. |
| **Cursor** | Solo tiene sentido en grabaciones hechas en el modo de cursor editable, en Windows, macOS o Linux. Mostrar/ocultar, recortar al lienzo, una tira de temas de cursor y controles deslizantes de tamaño, suavizado, desenfoque de movimiento y rebote al clic. |
| **Transcripción** | La transcripción conjunta de todos los clips, editable: consulta [Edición de la transcripción](./captions.md#transcript-editing). Su botón **Subtítulos** activa los subtítulos, les da estilo y los traduce: consulta [Subtítulos y transcripción](./captions.md#captions). |

El botón del **lápiz** de la misma barra abre la ventana **Editar clip** del clip seleccionado: un rectángulo de recorte arrastrable con campos numéricos X/Y/A/Al y proporciones predefinidas, más los puntos de entrada y salida del clip. El recorte de imagen es por clip, no por proyecto.

Al seleccionar una región en la línea de tiempo (un bloque de zoom, recorte, anotación, velocidad o cámara a pantalla completa), el contenido del panel se reemplaza por un inspector de esa región, que se describe más abajo junto a cada tipo de región.

## Barra de herramientas de la línea de tiempo {#timeline-toolbar}

- **Mejora automática** (ícono de varita): un menú con dos pasadas que se ejecutan una sola vez:
  - **Zooms automáticos**: lee el movimiento grabado del cursor y coloca regiones de zoom en los momentos en que el cursor se detiene. Sin red ni modelo. [Zoom automático](/features/auto-zoom/) explica cómo se eligen esos momentos.
  - **Cortes inteligentes** (marcado *Con IA*): en su lugar, le encarga el trabajo al agente de IA, que necesita un [proveedor conectado](./ai-editing.md).
- **Velocidad** (`S`): agrega una región de cambio de velocidad en el cabezal de reproducción.
- **Comentario** (`A`): agrega una anotación en el cabezal de reproducción.
- **Recortar** (`T`): coloca un corte de dos segundos ("región de recorte") en el cabezal de reproducción. Arrastra sus bordes para cambiar su tamaño, como con cualquier otra región.
- **Agregar zoom** (`Z`): coloca una región de zoom animada en el cabezal de reproducción.
- **Enfoque automático** (mira): interruptor; cuando está activado, todas las regiones de zoom siguen al cursor y el control de enfoque de cada zoom queda bloqueado.
- **Cámara a pantalla completa** (`C`): agrega un segmento en el que la cámara web ocupa todo el cuadro.

Arrastra los bordes de una región para cambiar su tamaño, o arrastra el bloque para moverlo. Las regiones se ajustan al cabezal de reproducción, a los bordes de otras regiones y al inicio y el final de la línea de tiempo. `Ctrl/Cmd + C` / `Ctrl/Cmd + V` copia los atributos de una región seleccionada en otra región del mismo tipo.

`Shift` + rueda del mouse desplaza la línea de tiempo; `Ctrl`/`Cmd` + rueda del mouse la acerca y la aleja. Ambos aparecen como sugerencias debajo de la barra de transporte.

### Regiones de zoom {#zoom-regions}

Haz clic en un bloque de zoom para abrir su inspector:
- Seis niveles de profundidad predefinidos: 1.25× / 1.5× / 1.8× / 2.2× / 3.5× / 5×.
- **Rotación 3D**: Ninguna, Iso, Izquierda o Derecha.
- **Modo de enfoque**: Manual (arrastra el marcador de enfoque en la vista previa) o Auto (sigue el cursor grabado). Queda fijo en Auto cuando el interruptor de enfoque automático de la barra de herramientas está activado.
- **Posición de enfoque**: porcentaje X/Y numérico en el modo manual.

Las regiones de zoom colocadas con **Mejora automática → Zooms automáticos** abren el mismo inspector. Cómo funciona esa pasada, y cómo se compara con los zooms automáticos de otros grabadores, se explica en [Zoom automático](/features/auto-zoom/).

### Regiones de recorte {#trim-regions}

Un tramo recortado se elimina de la reproducción y de la exportación. El inspector tiene una sola acción, **Eliminar**: presiona `Del` o usa el botón del inspector. Los mismos cortes también pueden hacerse desde el texto, en la [transcripción](./captions.md#transcript-editing).

### Regiones de velocidad {#speed-regions}

Un menú desplegable de valores predefinidos (de 0.25× a 5×, más 1× para volver a la velocidad normal) y un campo numérico libre que acepta cualquier valor hasta 100×. En ambos casos, la exportación renderiza la velocidad real.

### Regiones de cámara a pantalla completa {#full-camera-regions}

Un tramo en el que la cámara web llena el cuadro en lugar de ocupar su recuadro de la disposición: útil para una introducción hablando a cámara en medio de una grabación de pantalla. Solo tiene sentido cuando la grabación tiene una pista de cámara web.

### Anotaciones {#annotations}

Cuatro tipos, que se cambian desde el menú desplegable **Tipo** del inspector. Cambiar de tipo conserva el tramo y el recuadro de la región, así que equivocarse al elegir cuesta un clic y no volver a dibujarla.

- **Texto**: contenido, tamaño, color de fondo con un interruptor para activarlo, color del texto y una animación de aparición (Ninguna / Desvanecimiento / Ascender / Aparecer / Deslizar izquierda / Máquina de escribir / Pulso).
- **Imagen**: sube un JPG, PNG, GIF o WebP.
- **Flecha**: ocho direcciones, grosor del trazo (1–20) y color.
- **Desenfoque**: una máscara de privacidad. Gaussiano o Mosaico, rectángulo u óvalo, con intensidad (o tamaño del bloque de mosaico). Arrástrala y cambia su tamaño sobre la vista previa como cualquier otra anotación.

:::note
Ya no se pueden dibujar formas de desenfoque a mano alzada. Las que ya existen se siguen renderizando, pero como su rectángulo delimitador: cubren de más a propósito en lugar de dejar visible en la exportación algo que marcaste como privado. El inspector lo indica cuando detecta una.
:::

## Estilo del cursor {#cursor-styling}

Si tu grabación tiene datos de cursor editables (captura nativa en el modo de cursor editable, en Windows, macOS o Linux; [Modo de cursor](./recording.md#cursor-mode) indica lo que graba cada plataforma), el panel Cursor te permite elegir en una biblioteca de temas de cursor y ajustar el tamaño, el suavizado, el desenfoque de movimiento y el rebote al clic con independencia de la captura original. La trayectoria subyacente del cursor se suaviza de forma determinista, así que lo que ves en la vista previa coincide con la exportación final.

## Atajos de teclado {#keyboard-shortcuts}

El ícono del engranaje de la barra superior abre el cuadro de diálogo de atajos, donde se pueden reasignar los que son configurables.

| Acción | Predeterminado |
|---|---|
| Agregar zoom | `Z` |
| Agregar recorte | `T` |
| Agregar velocidad | `S` |
| Agregar anotación | `A` |
| Agregar cámara a pantalla completa | `C` |
| Añadir audio | `M` |
| Grabar voz en off | `V` |
| Eliminar seleccionado | `Ctrl/Cmd + D` |
| Reproducir / Pausar | `Space` |
| Copiar los atributos de la región | `Ctrl/Cmd + C` |
| Pegar los atributos de la región | `Ctrl/Cmd + V` |
| Abrir aplicación (funciona desde cualquier app) | `Ctrl/Cmd + Shift + O` |

Fijos (no se pueden reasignar):

| Acción | Atajo |
|---|---|
| Deshacer | `Ctrl/Cmd + Z` |
| Rehacer | `Ctrl/Cmd + Shift + Z` (o `+ Y`) |
| Eliminar seleccionado (alt) | `Del` / `⌫` |
| Recorrer anotaciones hacia adelante / hacia atrás | `Tab` / `Shift + Tab` |
| Fotograma anterior / siguiente | `←` / `→` |
| Desplazar línea de tiempo | `Shift + Scroll` |
| Zoom en línea de tiempo | `Ctrl + Scroll` |

## Guardar tu trabajo {#saving-your-work}

Las ediciones se guardan en un archivo de proyecto `.openscreen`, separado de cualquier video exportado y totalmente reeditable:

- **Guardar proyecto** (`Ctrl/Cmd + S`): guarda en el mismo lugar, o pide una ubicación la primera vez.
- **Cargar proyecto** (`Ctrl/Cmd + O`): abre un archivo `.openscreen` existente.
- **Nuevo proyecto** (`Ctrl/Cmd + N`): vacía el proyecto actual.

La barra superior muestra un indicador **Guardado** / **Sin guardar**, y si cierras con cambios sin guardar, la app te pide que guardes, descartes o canceles.

Cuando estés listo, ve a [Exportación](./export.md).
