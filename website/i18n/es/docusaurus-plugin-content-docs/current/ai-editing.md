---
id: ai-editing
title: Edición con IA
sidebar_position: 8
description: "Conecta tu propia clave de LLM y edita proyectos de OpenScreen desde un chat. Opcional y desactivado por defecto: nada llega a un modelo hasta que conectes uno."
keywords:
  - edición de video con IA
  - editor de video con LLM
  - editar video por chat
  - usar tu propia clave API
  - privacidad
---

# Edición con IA

OpenScreen incluye un agente opcional que edita tu proyecto desde un panel de chat. Está **desactivado hasta que tú mismo conectes un proveedor**, y antes de eso no se envía nada a ningún modelo. Una vez conectado, el agente solo se comunica con ese proveedor, y lo mismo ocurre con la [traducción de subtítulos](./captions.md#translation). Los demás usos de la red que hace la app (la descarga de los modelos de transcripción, la búsqueda de actualizaciones) se enumeran en las [preguntas frecuentes](./faq.md#does-openscreen-work-offline).

:::tip
Nada de esto es obligatorio. La grabación, la edición, la transcripción, los subtítulos y la exportación funcionan sin cuenta y sin proveedor, abras o no alguna vez el panel de chat. De todo eso, solo la transcripción necesita una descarga, una única vez: sus [modelos](./captions.md#transcribing), en tu primer uso.
:::

## Conectar un proveedor {#connecting-a-provider}

Abre la columna de chat (el interruptor del extremo izquierdo de la barra superior, en el modo **Editar**) y luego **Configuración de IA** → elige un proveedor y pega una clave API:

| Proveedor | Notas |
|---|---|
| **Claude API** (Anthropic) | |
| **OpenAI API** | |
| **Gemini API** (Google) | |
| **Mistral API** | |
| **OpenRouter API** | Una clave, muchos modelos. |
| **MiniMax API** / **MiniMax Token Plan** | |
| **OpenAI Compatible** | Cualquier endpoint con el formato de OpenAI: tú indicas la URL base. |

Tu clave se guarda cifrada mediante la protección de credenciales de tu sistema operativo (Electron `safeStorage`); si el cifrado no está disponible, la escritura falla en lugar de recurrir a texto sin cifrar. Los servidores de OpenScreen nunca la ven, porque no existen: las solicitudes van directamente de tu equipo al proveedor que elegiste. También funcionan las variables de entorno propias de cada proveedor, si prefieres no guardar ninguna clave.

:::note
Las opciones de inicio de sesión con ChatGPT y GitHub Copilot se **eliminaron en la 1.8.0**. Funcionaban incluyendo credenciales de cliente oficiales que pertenecen a esas empresas, y no nos corresponde redistribuirlas. Usa en su lugar un proveedor con clave API.
:::

## Usar el agente {#using-the-agent}

Describe la edición con tus propias palabras: "corta el tiempo muerto de la introducción", "haz zoom cuando abro la terminal". El agente trabaja con operaciones reales de la línea de tiempo, que se pueden deshacer, y no con un nuevo renderizado: puede agregar y ajustar recortes, zooms, regiones de velocidad, anotaciones (texto, flechas y desenfoques que ocultan datos privados en pantalla), pistas de audio importadas con sus fundidos y segmentos de cámara a pantalla completa, agregar zooms automáticos en tus clics, editar los puntos de entrada y salida y el recorte de un clip, colocar el material de otra fuente, duplicar, reordenar o quitar clips, y leer la transcripción para encontrar aquello a lo que te refieres. También ajusta el aspecto del vídeo: fondo, margen, esquinas redondeadas, sombra, marco de dispositivo, formato, la disposición de la cámara, el cursor y el volumen general. También puede activar los [subtítulos](./captions.md), darles estilo y colocarlos, y traducirlos él mismo a otro idioma. Y puede escribir un efecto visual que los ajustes no ofrecen: consulta [Efectos personalizados](./effects.md).

El panel que lo rodea:

- **Conversaciones**: historial, renombrar, eliminar y empezar una nueva. Cada una conserva su propio estado del agente.
- **Selector de modelo**: lista en vivo de los modelos del proveedor conectado, con un control de esfuerzo de razonamiento cuando el proveedor lo admite.
- **Medidor de contexto**: tokens estimados usados frente al presupuesto, con una acción **Compactar contexto** que resume los turnos anteriores en lugar de descartarlos.
- **Rebobinar a este mensaje**: revierte las ediciones del agente y todos los turnos posteriores a ese punto, y restaura a la vez el proyecto, la conversación y el estado del agente.
- **Ediciones del agente**: un interruptor en **Ajustes de IA**. Cuando está desactivado, se rechaza toda edición que el agente intente: puede seguir leyendo el proyecto y describiendo el cambio que haría, pero no aplica nada hasta que vuelvas a activar el interruptor.

`Ctrl/Cmd + Z` deshace una edición del agente exactamente igual que una manual.

La opción **Cortes inteligentes** (marcada *Con IA*) del menú de mejora automática de la línea de tiempo es el mismo agente con una única instrucción. (La otra opción, **Zooms automáticos**, lee los clics grabados y no necesita ningún proveedor).

## Qué más usa tu proveedor {#what-else-uses-your-provider}

La [traducción de subtítulos](./captions.md#translation) es una sola llamada de transformación de texto al mismo modelo: no ejecuta el ciclo del agente y no puede tocar tu documento. Si se lo pides en el chat, el agente traduce él mismo los subtítulos, en la misma capa de traducción. La transcripción y el renderizado de los subtítulos se hacen por completo en tu equipo en cualquier caso.

## Usar Claude Code, Codex u otro cliente MCP {#using-claude-code-codex-or-another-mcp-client}

Si ya usas un agente de código con IA como Claude Code o Codex, puede manejar las mismas herramientas de edición, con la sesión iniciada en su propia cuenta. Nada de esa cuenta pasa por OpenScreen.

1. **Configuración de IA** → **Servidor MCP** → actívalo. Solo escucha en tu propio equipo (`127.0.0.1`), en el puerto que se muestra.
2. Copia el comando de **Claude Code** o de **Codex** que aparece ahí y ejecútalo en una terminal. El comando de Claude Code lleva el token de acceso. Codex, en cambio, lo lee de la variable de entorno `OPENSCREEN_MCP_TOKEN`: defínela en el shell desde el que inicias Codex.
3. Pídele la edición a tu agente, sobre el proyecto abierto en el editor de OpenScreen o sobre cualquier otro proyecto de tu lista.

Las herramientas son las que usa el agente integrado, además de las que graban, exportan y miran un video ([más abajo](#letting-an-agent-make-the-whole-video)). También está `transcribe`, que ejecuta Whisper en tu equipo sobre los medios de un proyecto, como hace el editor al abrir un proyecto. Un cliente traduce los subtítulos con su propio modelo, así que la traducción de subtítulos no necesita ningún proveedor en OpenScreen. Las herramientas actúan sobre el proyecto abierto en el editor, salvo que el cliente indique otro: puede listar todos los proyectos y leer o editar cualquiera de ellos. También puede crear un proyecto, vacío o a partir de un archivo de video, cambiarle el nombre a uno, y agregar un archivo de video o de audio a los medios de un proyecto o quitar uno. Eliminar un proyecto no está entre las herramientas: eso queda en tus manos, en la aplicación. Los clientes MCP solo pueden **leer** hasta que también actives **Ediciones por MCP** en la sección Servidor MCP: hasta entonces se rechaza cada edición, grabación, exportación o proyecto nuevo que intenten. Este interruptor es independiente de **Ediciones del agente**, el del agente integrado, y empieza desactivado. Una vez activado, cada edición se guarda en cuanto se aplica:

- **En el proyecto abierto en el editor**, una edición se deshace con `Ctrl/Cmd + Z`. A los clientes se les indica que guarden un punto de restauración antes de una serie de ediciones, así que puedes pedirles que dejen el proyecto como estaba en un solo paso, que el propio `Ctrl/Cmd + Z` puede deshacer.
- **En cualquier otro proyecto**, una edición se guarda en su archivo, fuera del alcance de `Ctrl/Cmd + Z`. Un cliente debe guardar un punto de restauración de ese proyecto antes de su primera edición, y volver a él es la única forma de deshacerla.

Los puntos de restauración se guardan en la memoria de OpenScreen: se pierden cuando se cierra o cuando el servidor se reinicia, lo que ocurre al cambiar el puerto o regenerar el token. Solo se conservan los 20 puntos de restauración más recientes, así que uno más antiguo puede desaparecer antes. **Regenerar** el token desconecta a todos los clientes configurados con el anterior.

## Dejar que un agente haga todo el video {#letting-an-agent-make-the-whole-video}

Un agente puede hacer un video completo por sí solo, desde la grabación hasta la exportación. Además de las herramientas de edición, las dos formas de agregar OpenScreen al agente le dan `listSources`, `startRecording`, `stopRecording`, `setPointerTrack`, `exportVideo`, `getFrames` y `createProject`. Una toma también puede grabar tu cámara web y el cursor propio del sistema, como la barra de grabación, y una exportación acepta las opciones del diálogo de exportación: calidad y velocidad de fotogramas para un MP4; velocidad de fotogramas, tamaño y bucle para un GIF.

**Con el servidor de arriba**, la toma la graba el propio OpenScreen, como con su botón Grabar: el editor se cierra, la barra de grabación hace su cuenta regresiva y graba, y la toma se abre en el editor como un proyecto nuevo, donde ves llegar cada edición. Necesita **Ediciones por MCP** activado, y la barra de grabación recupera tus propios ajustes al terminar la toma.

**Como servidor stdio**, no necesita ningún ajuste: el agente inicia el propio ejecutable de la app con `mcp`.

La forma más rápida es pegar esto en Claude Code:

```text
Install the OpenScreen demo skill with `npx skills add getopenscreen/openscreen --skill openscreen-demo -a claude-code`, then follow it to make a demo video of this feature.
```

El skill instala OpenScreen si falta, una vez que aceptes, y agrega su servidor MCP. Luego te pide que abras una nueva sesión y digas *continue the OpenScreen demo*: un agente solo obtiene herramientas nuevas en una nueva sesión. Para configurarlo a mano en cambio:

```bash
claude mcp add openscreen -- "<executable>" mcp
codex mcp add openscreen -- "<executable>" mcp
```

`<executable>` es el ejecutable de la app; el de cada sistema aparece en [Ejecutar la CLI](./cli.md#running-the-cli). Otros clientes, como Cursor, usan un servidor stdio con el ejecutable como `command` y `["mcp"]` como `args`.

- **Sin puerto, sin token, sin ajuste.** El agente inicia el proceso él mismo, con tus permisos, como ejecutaría `openscreen record`. Así puede grabar tu pantalla y editar sin el interruptor **Ediciones por MCP**.
- **Cada toma se convierte en un proyecto nuevo** en tu lista de proyectos, con zooms en sus clics, como una grabación hecha en la app: los clics cercanos en el tiempo y en la pantalla comparten un zoom, y los primeros segundos y el final se quedan en la pantalla completa. Cada edición del agente se guarda en el archivo del proyecto. Se deshace con el punto de restauración que toma el agente, que dura hasta que termina su sesión. Solo se conservan los 20 puntos de restauración más recientes, así que uno más antiguo puede desaparecer antes.
- **Mientras OpenScreen está abierto, el agente trabaja a través de la app.** Una edición del proyecto abierto en el editor aparece ahí al instante, y `Ctrl/Cmd + Z` la deshace. Los puntos de restauración del agente duran entonces hasta que cierres OpenScreen. Si la app no responde, las ediciones de ese proyecto se rechazan, porque el editor guardaría su propia copia encima.
- **Una toma no tiene transcripción hasta que el agente la pide.** Llama a `transcribe` antes de cortar palabras o de activar los subtítulos. Whisper se ejecuta en tu equipo, dentro de OpenScreen cuando está abierto.
- **Una toma controlada por un script** (Playwright, por ejemplo) nunca mueve el puntero de la pantalla. El agente le pasa a OpenScreen su propio registro de las acciones con `setPointerTrack`, y el video obtiene igualmente un cursor y sus zooms.
- **La skill `openscreen-demo`** le enseña a un agente todo el trabajo, desde el storyboard hasta el video terminado. Después adjunta el video a un pull request, para que los revisores vean el cambio ahí mismo, o redacta un post en X que solo publica cuando dices que sí. Agrégala con `npx skills add getopenscreen/openscreen --skill openscreen-demo`. La receta es [`plugin/skills/openscreen-demo/SKILL.md`](https://github.com/getopenscreen/openscreen/blob/main/plugin/skills/openscreen-demo/SKILL.md).
