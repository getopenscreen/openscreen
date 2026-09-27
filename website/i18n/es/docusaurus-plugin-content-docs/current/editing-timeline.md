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
| **Composición** | Una sección de fondo (imagen, color sólido o degradado detrás de tu grabación; sube tu propia imagen o elige un preajuste), con una fila **Animación** (Ninguno, Deriva, Aurora, Ondas) que mueve por igual degradados e imágenes, y un desenfoque de fondo de 0 a 100 %. Luego el cuadro: sombra (Ninguna, Suave, Media, Fuerte), relleno, redondez de las esquinas y desenfoque de movimiento. Su fila **Formato** define la forma de salida para la vista previa y la exportación: **Auto** (la predeterminada en los proyectos nuevos), que ajusta el cuadro alrededor de tu grabación y de la disposición de cámara con un borde de relleno uniforme, las formas propias de tus clips en **Original**, más 16:9, 9:16, 1:1, 4:3, 4:5, 16:10 y 10:16. |
| **Disposición de cámara** | Composición de la cámara web: imagen en imagen, apilado vertical, marco dual o sin cámara. Reflejo y "reducir al ampliar". En imagen en imagen: forma de la cámara (rectángulo o cuadrado), redondez (del todo redonda, una cámara cuadrada es un círculo), tamaño y posición: uno de ocho puntos junto al borde, siempre a la misma distancia de él. Arrastra la cámara web sobre el lienzo y se ajusta al punto más cercano. |
| **Audio** | El nivel de salida, que se aplica igual en la vista previa y en la exportación. |
| **Cursor** | Solo tiene sentido en grabaciones hechas en el modo de cursor editable, en Windows, macOS o Linux. Mostrar/ocultar y ocultar automáticamente, el estilo del cursor con su interruptor **Cursor 3D**, los tipos de cursor (cada tipo que muestra el video, dibujado tal como se grabó o como la flecha), controles deslizantes de tamaño (hasta cuatro veces el predeterminado), suavizado y desenfoque de movimiento, el rebote al clic (Ninguno, Suave, Marcado) e **Impacto del clic**, que empuja la pantalla hacia atrás en cada clic con cualquier cámara. |
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

`Shift` + rueda del mouse desplaza la línea de tiempo; `Ctrl`/`Cmd` + rueda del mouse la acerca y la aleja. Ambos aparecen como sugerencias junto a los controles de reproducción.

### Regiones de zoom {#zoom-regions}

Haz clic en un bloque de zoom para abrir su inspector:
- Seis niveles de profundidad predefinidos: 1.25× / 1.5× / 1.8× / 2.2× / 3.5× / 5×.
- **Cámara 3D**: Desactivada, Pantalla girada a la izquierda, Pantalla girada a la derecha u Órbita 3D (una cámara que se mueve con el zoom y sigue su modo de enfoque).
- **Modo de enfoque**: Manual (arrastra el marcador de enfoque en la vista previa) o Auto (sigue el cursor grabado). Queda fijo en Auto cuando el interruptor de enfoque automático de la barra de herramientas está activado.
- **Posición de enfoque**: porcentaje X/Y numérico en el modo manual.

Las regiones de zoom colocadas con **Mejora automática → Zooms automáticos** abren el mismo inspector. Cómo funciona esa pasada, y cómo se compara con los zooms automáticos de otros grabadores, se explica en [Zoom automático](/features/auto-zoom/).

### Regiones de recorte {#trim-regions}

Un tramo recortado se elimina de la reproducción y de la exportación. El inspector tiene una sola acción, **Eliminar**: presiona `Del` o usa el botón del inspector. Los mismos cortes también pueden hacerse desde el texto, en la [transcripción](./captions.md#transcript-editing).

### Regiones de velocidad {#speed-regions}

Una fila de botones predefinidos (0.5×, 1×, 1.5×, 2×, 4×) y un campo numérico libre para cualquier otra velocidad de 0.25× a 16×. En ambos casos, la exportación renderiza la velocidad real.

### Regiones de cámara a pantalla completa {#full-camera-regions}

Un tramo en el que la cámara web llena el cuadro en lugar de ocupar su recuadro de la disposición: útil para una introducción hablando a cámara en medio de una grabación de pantalla. Solo tiene sentido cuando la grabación tiene una pista de cámara web.

### Anotaciones {#annotations}

Cuatro tipos, que se eligen en la fila **Tipo** del inspector. Cambiar de tipo conserva el tramo de la región y su lugar en la imagen.

Los textos, las imágenes y las flechas se colocan sobre el cuadro: arrástralos a donde quieras, también sobre el relleno. Ni el relleno ni el tamaño de la grabación los mueven, y un cambio de formato conserva su forma. Un desenfoque se queda sobre la grabación, encima de lo que oculta.

- **Texto**: contenido, tamaño (24, 32, 48 o 72, o cualquier tamaño escrito al lado), fondo (Ninguna / Oscura / Clara), color del texto y una animación de aparición (Ninguna / Desvanecimiento / Ascender / Aparecer / Deslizar izquierda / Máquina de escribir / Pulso). El recuadro de selección es el propio texto: arrastra una esquina para cambiar su tamaño.
- **Imagen**: sube un JPG, PNG, GIF o WebP.
- **Flecha**: ocho direcciones, grosor del trazo (1–20) y color.
- **Desenfoque**: una máscara de privacidad. Gaussiano o Mosaico, rectángulo u óvalo. Arrástrala y cambia su tamaño sobre la grabación como cualquier otra anotación.

:::note
Ya no se pueden dibujar formas de desenfoque a mano alzada. Las que ya existen se siguen renderizando, pero como su rectángulo delimitador: cubren de más a propósito en lugar de dejar visible en la exportación algo que marcaste como privado. El inspector lo indica cuando detecta una.
:::

## Estilo del cursor {#cursor-styling}

Si tu grabación tiene datos de cursor editables (captura nativa en el modo de cursor editable, en Windows, macOS o Linux; [Modo de cursor](./recording.md#cursor-mode) indica lo que graba cada plataforma), el panel Cursor te permite ajustar su estilo, tamaño, suavizado, desenfoque de movimiento, rebote al clic e impacto del clic con independencia de la captura original. La trayectoria subyacente del cursor se suaviza de forma determinista, así que lo que ves en la vista previa coincide con la exportación final.

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
