---
id: recording
title: Grabación de pantalla
sidebar_position: 4
sidebar_label: Grabación
description: "Graba una ventana o toda la pantalla con el HUD de OpenScreen: audio del sistema, micrófono, cámara web, modos de cursor, cuenta regresiva y captura nativa."
keywords:
  - grabar pantalla
  - grabar una ventana
  - grabar audio del sistema
  - grabar cámara web
  - ScreenCaptureKit
  - Windows Graphics Capture
  - PipeWire
---

# Grabación de pantalla

La grabación se hace desde el **HUD**: una píldora superpuesta, que puedes arrastrar y que siempre queda por encima de las demás ventanas. Ignora los clics del mouse en todas partes excepto en sus propios controles, así que nunca estorba a la app que estás grabando.

## Elegir una fuente {#choosing-a-source}

El botón del selector de fuente muestra la pantalla o ventana seleccionada (con el nombre truncado) y se desactiva cuando empieza la grabación. Al hacer clic en él se abre una ventana aparte con dos pestañas:

- **Pantallas**: una tarjeta por monitor.
- **Ventanas**: una tarjeta por ventana abierta, con el ícono de su app.

Elige una miniatura y haz clic en **Compartir**. Si no hay ninguna fuente seleccionada cuando presionas grabar, OpenScreen abre primero el selector y empieza a grabar automáticamente en cuanto eliges una.

No existe la captura de una región: grabas una pantalla completa o una ventana, y después encuadras la imagen, clip por clip, en el editor.

En Linux, el HUD no muestra selector de fuente, solo *El sistema te preguntará qué compartir*. Esa elección le corresponde al portal ScreenCast: al presionar grabar se abre el cuadro de diálogo para compartir de tu escritorio antes de la cuenta regresiva, y vuelve a preguntar en cada toma.

## Audio {#audio}

Tres interruptores comparten un mismo grupo de controles:

- **Audio del sistema**: captura lo que se reproduce en el equipo. Se desactiva cuando empieza la grabación.
- **Micrófono**: al activarlo (cuando no estás grabando) se abre una ventana emergente con un medidor de nivel de audio en vivo de 5 barras y una lista desplegable con todos los dispositivos de entrada disponibles, para que confirmes el micrófono correcto antes de empezar.
- **Cámara web**: al activarla se muestra un selector de cámara con los estados que cabe esperar (buscando, no disponible, no se encontró cámara). La cámara web se graba como su propia pista, que se compone después en el editor.

La compatibilidad con el audio del sistema depende de tu sistema operativo: consulta las [diferencias entre plataformas](./installation.md#platform-differences).

## Modo de cursor {#cursor-mode}

En Windows, macOS y Linux, un interruptor de modo de cursor alterna entre:
- **Cursor editable** (predeterminado): el cursor del sistema queda fuera de los píxeles y su movimiento se graba como datos, así que OpenScreen puede dibujar un cursor cuyo tema, tamaño y animación ajustas en el editor.
- **Cursor del sistema**: graba el cursor del sistema tal cual, sin editar.

Lo que captura el cursor editable depende de la plataforma:
- **Windows**: la forma real del cursor y los clics.
- **macOS**: la forma del cursor y los clics, que necesitan el permiso de Accesibilidad. En este modo, si presionas grabar sin ese permiso, en lugar de empezar se abre un aviso con un enlace al ajuste (consulta la [instalación en macOS](./installation.md#macos)).
- **Linux**: la posición y la forma mediante el portal ScreenCast, más los clics izquierdos cuando tu usuario está en el grupo `input` (consulta [Clics del mouse en Wayland](./installation.md#mouse-clicks-on-wayland)).

Una toma en Linux que recurre a la [captura por navegador](#native-vs-browser-capture) graba el cursor del sistema, sea cual sea el modo que elegiste.

## Controles de grabación {#recording-controls}

- **Grabar / Detener**: una píldora que, en reposo, muestra el nombre de la fuente al pasar el mouse y, durante la grabación, un contador `mm:ss` del tiempo transcurrido (el fondo se vuelve ámbar si está en pausa).
- **Pausar grabación / Reanudar grabación**: disponibles durante la grabación.
- **Reiniciar grabación**: descarta la toma actual y empieza de cero.
- **Cancelar grabación**: descarta la toma actual sin guardarla.
- **Abrir Studio**: cambia al editor (oculto durante la grabación).

## Cuenta regresiva {#countdown}

Al presionar grabar se inicia una cuenta regresiva 3‑2‑1, que se muestra superpuesta sobre todo el escritorio, antes de que empiece realmente la captura.

## Otros controles del HUD {#other-hud-controls}

- **Interruptor de orientación**: cambia el HUD entre horizontal y vertical, y la elección se conserva entre sesiones.
- **Ajustes de dispositivos**: los ajustes del micrófono y la cámara seleccionados, sin salir del HUD.
- **Abrir notas** (no disponible en Linux): abre una pequeña ventana de notas con texto enriquecido, práctica para tener un guion o una lista de indicaciones mientras grabas. Se guarda localmente entre sesiones.
- **Idioma**: un selector de idioma (13 idiomas) que solo afecta a la interfaz de OpenScreen, no a tu grabación.
- Controles de ventana para ocultar el HUD o salir de la app.

## Grabar desde el editor (modo Grabar) {#recording-from-the-editor-rec-mode}

No tienes que empezar desde el HUD. En el editor, cambia la barra superior a **Grabar** para obtener una página de preparación a tamaño completo en lugar de una píldora:

- **Fuente**: el mismo selector de pantalla o ventana, en una ventana modal. En Linux, esta fila también dice *El sistema te preguntará qué compartir*, y el cuadro de diálogo del portal es el que elige.
- **Audio del sistema**, **Micrófono**, **Cámara**: cada uno es una fila que se activa o desactiva; el micrófono y la cámara se despliegan en una lista de dispositivos, y la cámara muestra una vista previa en vivo para que te encuadres antes de empezar.
- **Resaltar cursor**: activado significa el cursor editable; desactivado, el cursor normal del sistema.

**Iniciar grabación** abre el widget de grabación y cierra la ventana del editor; si cancelas, vuelves al modo Editar. Este es también el punto de partida al que te lleva **Nuevo proyecto → Grabación de pantalla**.

## Captura nativa frente a captura por navegador {#native-vs-browser-capture}

Todas las plataformas graban la pantalla con un módulo auxiliar nativo: ScreenCaptureKit en macOS, Windows Graphics Capture en Windows 10 compilación 19041 y posteriores, y PipeWire mediante el portal ScreenCast en Linux. La cámara web solo se captura de forma nativa en Windows; macOS y Linux la graban a través del navegador. En los tres sistemas se guarda como un archivo aparte y se compone en el editor.

La captura por navegador reemplaza al módulo auxiliar nativo solo en compilaciones de Windows anteriores a la 19041, o cuando a una compilación de Windows o Linux le falta su módulo. Si un módulo nativo falla, no hay respaldo: la grabación notifica el error. Consulta la [tabla completa de diferencias entre plataformas](./installation.md#platform-differences).

Cuando detengas la grabación, ve a [Edición y línea de tiempo](./editing-timeline.md) para darle forma, o a [Biblioteca multimedia](./media-library.md) si vas a unir varias tomas.
