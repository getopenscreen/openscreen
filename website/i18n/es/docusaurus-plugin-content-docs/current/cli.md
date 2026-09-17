---
id: cli
title: CLI de grabación de pantalla para scripts y agentes
sidebar_label: CLI
description: "La CLI de grabación de pantalla de OpenScreen graba, subtitula y exporta proyectos .openscreen desde scripts, CI y agentes de código, con salida NDJSON."
keywords:
  - grabar pantalla desde la línea de comandos
  - CLI para grabar pantalla
  - grabador de pantalla sin interfaz gráfica
  - automatizar video de demostración de producto
  - NDJSON
  - openscreen export
---

# CLI de grabación de pantalla

La interfaz de línea de comandos de OpenScreen está integrada en el propio ejecutable de la app de escritorio. `openscreen record`, `captions`, `export`, `pack`, `info` y `sources` se ejecutan desde una terminal sin abrir ninguna ventana, y `--json` convierte su salida en NDJSON por stdout. Un script, un trabajo de CI o un agente de código puede grabar una toma, editar el proyecto `.openscreen` como JSON normal y renderizar un MP4 o un GIF con el mismo compositor nativo que el botón **Exportar** del editor.

No es una herramienta para servidores. Cada comando inicia Electron, que necesita un servidor gráfico aunque no aparezca ninguna ventana, y grabar requiere una sesión de escritorio real. Consulta [Cuándo la CLI no es la herramienta adecuada](#when-the-cli-is-not-the-right-tool).

:::caution
La CLI y el formato de proyecto `.openscreen` todavía pueden cambiar de forma incompatible entre versiones. Revisa tus scripts después de cada actualización.
:::

## Ejecutar la CLI {#running-the-cli}

Primero [instala OpenScreen](/download/) ([Instalación](./installation.md)). Cada comando es un subcomando del ejecutable de la app:

| Instalación | Ejecutable |
|---|---|
| macOS | `/Applications/Openscreen.app/Contents/MacOS/Openscreen` |
| Instalador de Windows | `Openscreen.exe` en la carpeta elegida durante la instalación: `%LOCALAPPDATA%\Programs\Openscreen\` si se instaló para el usuario actual, `C:\Program Files\Openscreen\` si se instaló para todos los usuarios |
| `.deb`, `.rpm`, `.pacman` de Linux | `openscreen` |
| AppImage de Linux | `./Openscreen-Linux-1.11.0.AppImage` |
| Nix | `openscreen` |

Los ejemplos de esta página escriben `openscreen`. En macOS y Windows, usa la ruta completa o un alias:

```bash
/Applications/Openscreen.app/Contents/MacOS/Openscreen export demo.openscreen -o demo.mp4
```

- `openscreen help`, `--help` o `-h` muestra el modo de uso.
- Las opciones de Chromium colocadas antes del subcomando se ignoran. Si el sandbox de Chromium no puede iniciarse en el equipo, ejecuta `./Openscreen-Linux-1.11.0.AppImage --no-sandbox export demo.openscreen`.
- Las ejecuciones de la CLI no toman el bloqueo de instancia única de la app, así que funcionan mientras la app de escritorio está abierta.
- Desde una copia del código fuente, compila la app y sus módulos auxiliares nativos como se describe en [Build and packaging (en inglés)](https://github.com/getopenscreen/openscreen/blob/main/technical-documentation/engineering/build-and-packaging.md), y luego ejecuta `npm run cli -- <command> [options]`.

## Comandos {#commands}

### `openscreen record` {#openscreen-record}

Para grabar la pantalla desde la línea de comandos, ejecuta `record`. Usa el mismo mecanismo de grabación que la app de escritorio, y los archivos se guardan en el directorio de grabaciones de la app, junto a las grabaciones hechas desde la interfaz gráfica: el video de la pantalla y, cuando se capturaron datos del puntero, un archivo de telemetría del cursor `<video>.cursor.json` que leen el cursor editable y `--auto-zoom`.

```bash
openscreen record --duration 30 --project demo.openscreen --json
openscreen record --window "My App" --mic --system-audio
openscreen record --display 1 --cursor system
```

| Opción | Significado |
|---|---|
| `--display <n>` | Índice de la pantalla, según lo que muestra `openscreen sources` (predeterminado: 0) |
| `--window <title>` | Graba la primera ventana cuyo título contenga `<title>`, sin distinguir mayúsculas de minúsculas. Tiene prioridad sobre `--display` |
| `--mic` | Captura el micrófono predeterminado |
| `--mic-device <name>` | Captura el micrófono cuya etiqueta contenga `<name>`, sin distinguir mayúsculas de minúsculas. Implica `--mic` |
| `--system-audio` | Captura el audio del sistema |
| `--cursor <editable-overlay\|system>` | `editable-overlay` (predeterminado) oculta el puntero del sistema y lo graba como datos, para que el editor pueda cambiar su estilo. `system` dibuja el puntero en el video |
| `--duration <seconds>` | Se detiene automáticamente tras ese tiempo |
| `--project <out.openscreen>` | Al terminar, escribe un archivo de proyecto que hace referencia a la grabación, listo para `export` o para el editor. Debe terminar en `.openscreen` |
| `--json` | Eventos NDJSON por stdout |

No hay opción de cámara web: una grabación hecha desde la CLI solo contiene la pantalla y el audio.

**Detener la grabación.** Sin `--duration`, detén una grabación con Ctrl+C (SIGINT), con SIGTERM o escribiendo `stop`, `q` o `quit` seguido de Enter en su stdin. Cerrar stdin no la detiene. Forzar la terminación del proceso omite el cierre normal, así que no se escriben ni el evento `done` ni el archivo de proyecto.

**Por plataforma**

- **macOS.** La captura pasa por el módulo auxiliar de ScreenCaptureKit, sin respaldo. Se necesita el permiso de Grabación de pantalla; en una compilación de desarrollo iniciada desde una terminal, concédeselo a la terminal. Con `--mic`, la CLI pide acceso al micrófono si no se ha concedido. Los clics y las formas del puntero solo se graban con el permiso de Accesibilidad.
- **Windows.** La captura pasa por el módulo auxiliar de Windows Graphics Capture, a partir de Windows 10 compilación 19041. En compilaciones anteriores, o sin el módulo, OpenScreen recurre a la captura por navegador. Windows nunca envía SIGTERM: usa Ctrl+C, `stop` por stdin o `--duration`.
- **Linux.** La captura pasa por el módulo auxiliar de PipeWire y el portal ScreenCast del escritorio. El selector propio del portal decide qué se graba, y se abre en cada ejecución y espera una respuesta, así que `--display` y `--window` no eligen la fuente y una grabación en Linux no puede empezar sin intervención. Necesita una sesión de escritorio con `xdg-desktop-portal`: una sesión SSH sin pantalla no puede grabar. Solo una compilación sin el módulo recurre a la captura de Chromium.

### `openscreen sources` {#openscreen-sources}

Muestra las pantallas, las ventanas y los micrófonos que la app puede ver, para que un script elija los valores de `--display`, `--window` y `--mic-device`. En Linux, el selector del portal sigue decidiendo qué captura `record`.

```bash
openscreen sources                   # human-readable
openscreen sources --json            # NDJSON on stdout
openscreen sources -o sources.json   # payload written to a file
```

Con `--json`, los datos llegan dentro del evento final `done`:

```json
{
  "event": "done",
  "success": true,
  "sources": {
    "displays": [{ "index": 0, "id": "screen:1:0", "name": "Entire screen" }],
    "windows": [{ "id": "window:210:0", "name": "My App" }],
    "microphones": [{ "label": "Built-in Microphone" }],
    "microphoneLabelsUnavailable": false
  }
}
```

`microphoneLabelsUnavailable` vale `true` cuando los nombres de los dispositivos requieren un permiso que no se ha concedido, o cuando no se pudo leer la lista de dispositivos en unos segundos.

**Por qué existe `-o`.** La CLI solo escribe su propia salida en stdout; los diagnósticos de Chromium van a stderr. Lo que envuelve al proceso es otra historia. `xvfb-run` de Ubuntu, la forma habitual de ejecutar un binario con interfaz gráfica en una máquina sin pantalla, mezcla stderr con stdout, así que las advertencias de inicio de Chromium llegan antes que el JSON y `openscreen sources --json | jq` falla. `-o <file>` escribe en un lugar que ningún envoltorio puede redirigir, y evita las diferencias de comillas y de codificación entre shells.

Los dos canales tienen estructuras distintas. stdout envuelve los datos en el evento `done`, porque es un evento dentro de un flujo. El archivo contiene solo los datos:

```bash
openscreen sources --json | jq 'select(.event == "done") | .sources.displays'   # stdout: inside the envelope
openscreen sources -o s.json && jq '.displays' s.json                             # file: the payload itself
```

El archivo solo se escribe si la ejecución tiene éxito, y de forma atómica: una ejecución fallida deja intacto un archivo anterior. Comprueba el código de salida, no si el archivo existe.

### `openscreen export` {#openscreen-export}

Renderiza un proyecto a MP4 o GIF con el compositor nativo que usa el editor para su vista previa y su exportación. Los zooms, los recortes, las regiones de velocidad, las anotaciones y los subtítulos, el cursor y el fondo salen todos del proyecto.

```bash
openscreen export demo.openscreen                          # format and quality from the project
openscreen export demo.openscreen -o out.mp4 --quality source
openscreen export demo.openscreen -o out.gif --gif-fps 20 --gif-size large
openscreen export demo.openscreen -o out.mp4 --auto-zoom --json
```

| Opción | Significado |
|---|---|
| `-o, --out <path>` | Archivo de salida. La extensión, `.mp4` o `.gif`, define el formato. Predeterminado: la ruta del proyecto con `.mp4` o `.gif` |
| `--format <mp4\|gif>` | Reemplaza el formato guardado en el proyecto. Debe coincidir con `--out` |
| `--quality <medium\|good\|source>` | Tamaño de salida: `medium` es 720p, `good` es 1080p y `source` sigue al clip más pequeño una vez recortado, así que nunca amplía. Un GIF también parte de este tamaño |
| `--gif-fps <15\|20\|25\|30>` | Fotogramas por segundo del GIF |
| `--gif-size <medium\|large\|original>` | Límite de altura del GIF que se aplica a ese tamaño: 720, 1080 o ninguno |
| `--auto-zoom` | Antes de renderizar, agrega zooms donde el puntero grabado se detuvo, con el mismo motor que los [zooms automáticos](/features/auto-zoom/) del editor. Los zooms existentes se conservan, y los nuevos nunca se superponen con ellos |
| `--audio <file>` | Mezcla un archivo de voz en off (mp3, wav o m4a) en el MP4. Solo MP4 |
| `--audio-mode <mix\|replace>` | `mix` (predeterminado) mantiene el audio de la grabación debajo de la voz en off, con una ganancia del 40 %; `replace` lo elimina |
| `--audio-offset <seconds>` | Retraso antes de que empiece la voz en off (predeterminado: 0) |
| `--json` | Progreso y resultado en NDJSON por stdout |

Las exportaciones MP4 desde la CLI son siempre **H.264 a 60 fps**. No hay opción de códec ni de fotogramas por segundo. El cuadro de diálogo de [Exportación](./export.md) de la app de escritorio ofrece además H.265 y 24 o 30 fps.

`--audio` actúa después del renderizado: el flujo de video se copia sin cambios, y se mezcla una nueva pista AAC que se escribe sobre el mismo archivo de salida.

**Dónde pueden estar los archivos multimedia.** Al cargar un proyecto, la app aprueba automáticamente los archivos multimedia a los que hace referencia solo si están en su directorio de grabaciones o en la carpeta del propio archivo de proyecto. Guarda un proyecto escrito a mano junto a sus archivos multimedia, o graba con la CLI, que usa el directorio de grabaciones.

**Sin cancelación.** Solo `record` atiende una solicitud de detención. Terminar el proceso es la única forma de abandonar una exportación; considera inutilizable lo que haya quedado en la ruta de salida.

### `openscreen captions` {#openscreen-captions}

Transcribe el audio del proyecto en tu equipo con Whisper y luego escribe anotaciones de subtítulos en el archivo de proyecto. No se sube nada, y el idioma se detecta automáticamente. La primera ejecución descarga una sola vez el modelo Whisper, de unos 264 MB, igual que la app de escritorio.

```bash
openscreen captions demo.openscreen --min-words 2 --max-words 7
openscreen export demo.openscreen -o demo.mp4   # captions are burned into the video
```

- `--min-words` y `--max-words` definen las palabras por subtítulo. Valores predeterminados: 2 y 7.
- Volver a ejecutarlo reemplaza los subtítulos que agregó antes. Las anotaciones que agregaste tú se conservan.
- El video de pantalla del proyecto debe tener una pista de audio, por ejemplo de `record --mic`.
- Los subtítulos se incrustan en la exportación. No se genera ningún archivo de subtítulos. Consulta [Subtítulos](./captions.md).

### `openscreen pack` {#openscreen-pack}

Copia un proyecto y todo aquello a lo que hace referencia (video de pantalla, video de la cámara web, telemetría del cursor) en una sola carpeta, y reescribe las rutas de los archivos multimedia en el proyecto copiado.

```bash
openscreen pack demo.openscreen --out bundle/
```

`-o` se acepta como forma corta de `--out`, que es obligatorio. La carpeta se puede mover o conservar como artefacto de CI: cuando las rutas absolutas guardadas ya no existen, la app recurre a archivos con el mismo nombre situados junto al archivo de proyecto.

### `openscreen info` {#openscreen-info}

Muestra a qué hace referencia un proyecto y si su video de pantalla todavía existe, además de su configuración de exportación y cuántos zooms, recortes, regiones de velocidad y anotaciones contiene.

```bash
openscreen info demo.openscreen --json
```

Termina con el código 1 cuando falta el video de pantalla al que hace referencia.

## Salida legible por máquinas {#machine-readable-output}

Con `--json`, stdout lleva un objeto JSON por línea. stderr solo lleva diagnósticos, incluidas las líneas de registro de la propia app.

```json
{"event":"started","command":"export"}
{"event":"progress","percentage":50,"currentFrame":60,"totalFrames":120,"estimatedTimeRemaining":3}
{"event":"done","success":true,"outputPath":"/path/out.mp4","format":"mp4","width":1920,"height":1080}
```

| Evento | Se envía cuando | Campos |
|---|---|---|
| `started` | Empieza una ejecución de `record`, `sources`, `export` o `captions` | `command` |
| `log` | Una línea de estado, como `Recording started` | `message` |
| `progress` | Se codifican fotogramas de la exportación | `percentage`, `currentFrame`, `totalFrames`, `estimatedTimeRemaining` en segundos. Mientras se mezcla `--audio`: `percentage` y `phase: "mixing-voiceover"` |
| `stopping` | `record` recibió una solicitud de detención | `reason`: `SIGINT`, `SIGTERM` o `stdin` |
| `warning` | La ejecución tuvo éxito, con una salvedad | `message` |
| `error` | Se informó un fallo | `message` |
| `done` | La ejecución terminó, con o sin éxito | `success` y, después, el resultado o `error` |

Lo que lleva `done`:

- **export:** `outputPath`, `format`, `width`, `height`.
- **record:** `screenVideoPath`, `cursorDataPath` (dónde va el archivo de telemetría; puede que no exista), `durationMs`; con `--project`, también `projectPath` y `projectData`, el proyecto que escribió.
- **sources:** `sources`.
- **captions:** `projectPath`, `captionCount`.
- **pack:** `projectPath`, `files`, `cursorData`. `pack` no envía ningún evento `started`.

`info --json` imprime un único objeto de resumen, sin campo `event`.

Un `pack` o un `info` que falla termina con un evento `error` sin `done`. Un cierre inesperado puede terminar con un evento `error`, o sin nada más en stdout. Confía en el código de salida.

**Códigos de salida**

| Código | Significado |
|---|---|
| `0` | Éxito |
| `1` | Fallo, incluido `info` sobre un proyecto cuyo video de pantalla falta |
| `2` | Argumentos incorrectos. El mensaje y el modo de uso van a stderr como texto plano, incluso con `--json` |

## Ejemplo: una demo de producto automatizada {#example-an-automated-product-demo}

Un script o un agente de código puede producir una demo con subtítulos y zooms sin abrir el editor:

```bash
# 1. Record 20 seconds of one window, with narration from the microphone
openscreen record --window "MyProduct" --mic --duration 20 --project demo.openscreen --json

# 2. Caption the narration on this machine
openscreen captions demo.openscreen --json

# 3. Add a manual zoom and a text label by editing the project JSON
node -e '
  const fs = require("fs");
  const p = JSON.parse(fs.readFileSync("demo.openscreen", "utf8"));
  p.editor.zoomRegions.push({ id: "z1", startMs: 2000, endMs: 6000, depth: 3,
    focus: { cx: 0.5, cy: 0.4 }, focusMode: "manual", source: "manual" });
  p.editor.annotationRegions.push({ id: "a1", startMs: 500, endMs: 4000,
    type: "text", content: "One-click setup", textContent: "One-click setup",
    position: { x: 8, y: 6 }, size: { width: 40, height: 12 },
    style: { fontSize: 24, color: "#fff" }, zIndex: 1 });
  fs.writeFileSync("demo.openscreen", JSON.stringify(p, null, 2));
'

# 4. Render, with automatic zooms added where the pointer paused
openscreen export demo.openscreen -o demo.mp4 --auto-zoom --json
```

En el paso 3, `depth` va de 1 a 6 (de 1.25× a 5×; 3 equivale a 1.8×), y `cx` y `cy` sitúan el centro del zoom como fracciones del cuadro.

Para narrar en su lugar con un motor de texto a voz, graba sin `--mic` y mezcla la voz en off al exportar. Sirve cualquier motor que escriba mp3, wav o m4a; aquí se muestra `say` de macOS:

```bash
say -o voice.m4a --file-format=m4af "Welcome to MyProduct. Here is a quick tour."
openscreen export demo.openscreen -o demo.mp4 --auto-zoom --audio voice.m4a --audio-mode replace
```

`captions` lee la pista de audio propia de la grabación, no una voz en off mezclada al exportar, así que una narración de texto a voz no recibe subtítulos de esta manera.

**Exportar un video de otra herramienta.** `export` no necesita una grabación de OpenScreen. El proyecto más pequeño que acepta es una ruta de archivo multimedia y un editor vacío, que se convierte en un único clip de duración completa con los ajustes predeterminados:

```json
{
  "version": 2,
  "media": { "screenVideoPath": "/path/to/clip.mp4" },
  "editor": {}
}
```

Guárdalo en la misma carpeta que el clip. Sin telemetría del cursor, `--auto-zoom` no tiene con qué trabajar.

## Pantallas, CI y servidores {#displays-ci-and-servers}

- Cada comando inicia Electron, que inicia Chromium, así que debe haber un servidor gráfico aunque no se abra ninguna ventana. En una máquina Linux sin pantalla, lo proporciona un servidor X virtual iniciado con `xvfb-run`.
- `export` no captura nada, así que funciona de esa manera, siempre que haya un controlador Vulkan: el compositor de Linux renderiza con Vulkan, y una máquina sin GPU necesita un controlador por software como lavapipe de Mesa. El flujo de trabajo de compilación Nix del proyecto renderiza así un MP4 a partir de un clip generado, con `xvfb-run` y lavapipe en un runner de Linux sin pantalla, y falla si no sale ningún MP4.
- `record` no funciona así. En ese mismo runner, Chromium no encuentra ninguna pantalla que capturar, y en Linux el selector del portal necesita de todos modos a una persona.

## Cuándo la CLI no es la herramienta adecuada {#when-the-cli-is-not-the-right-tool}

- **Necesitas grabar en un servidor** sin pantalla ni sesión de escritorio. Grabar requiere un escritorio real, y en Linux alguien tiene que responder al selector del portal en cada ejecución.
- **Necesitas una API estable y versionada.** La CLI y el formato de proyecto todavía pueden cambiar entre versiones.
- **Necesitas controlar el códec, los fotogramas por segundo o la tasa de bits desde la línea de comandos.** Las exportaciones MP4 de la CLI son H.264 a 60 fps, y la tasa de bits del MP4 tampoco se puede ajustar en la app.
- **Necesitas la cámara web en una grabación automatizada.** `record` no tiene opción de cámara.
- **Necesitas archivos de subtítulos.** Los subtítulos solo se incrustan en el video.

Para un recorrido práctico por los mismos pasos en el editor, consulta [Cómo hacer un video de demostración de producto](./guides/product-demo-video.md). Las respuestas sobre la licencia y el uso de la red están en las [preguntas frecuentes](./faq.md).

## Código fuente {#source-code}

La CLI forma parte del [repositorio de OpenScreen](https://github.com/getopenscreen/openscreen):

- `electron/cli/args.ts`: el analizador de argumentos y el texto de uso, con pruebas unitarias en `args.test.ts`.
- `electron/cli/cliMain.ts`: el arranque sin ventana, el protocolo stdio, las señales de detención y los códigos de salida.
- `electron/cli/projectCommands.ts`: `pack` e `info`.
- `src/cli/`: los ejecutores en ventana oculta de `record`, `sources`, `export` y `captions`.
- `src/lib/cliContracts.ts`: los tipos de solicitud y de resultado que comparten ambos lados.
