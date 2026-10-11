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

OpenScreen incluye un agente opcional que edita tu proyecto desde un panel de chat. Está **desactivado hasta que tú mismo conectes un proveedor**, y antes de eso no se envía nada a ningún modelo. Una vez conectado, el agente solo se comunica con ese proveedor, y lo mismo ocurre con la [traducción de subtítulos](./captions.md#translation). Los demás usos de la red que hace la app (la descarga del modelo Whisper, las fuentes de las anotaciones, la búsqueda de actualizaciones) se enumeran en la [introducción](./intro.md).

:::tip
Nada de esto es obligatorio. La grabación, la edición, la transcripción, los subtítulos y la exportación funcionan sin cuenta y sin proveedor, abras o no alguna vez el panel de chat. De todo eso, solo la transcripción necesita una descarga, una única vez: el [modelo Whisper](./captions.md#transcribing), en tu primer uso.
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

Describe la edición con tus propias palabras: "corta el tiempo muerto de la introducción", "haz zoom cuando abro la terminal". El agente trabaja con operaciones reales de la línea de tiempo, que se pueden deshacer, y no con un nuevo renderizado: puede agregar y ajustar recortes, zooms, regiones de velocidad, anotaciones y segmentos de cámara a pantalla completa, editar los puntos de entrada y salida de los clips, reordenar o quitar clips, y leer la transcripción para encontrar aquello a lo que te refieres.

El panel que lo rodea:

- **Conversaciones**: historial, renombrar, eliminar y empezar una nueva. Cada una conserva su propio estado del agente.
- **Selector de modelo**: lista en vivo de los modelos del proveedor conectado, con un control de esfuerzo de razonamiento cuando el proveedor lo admite.
- **Medidor de contexto**: tokens estimados usados frente al presupuesto, con una acción **Compactar contexto** que resume los turnos anteriores en lugar de descartarlos.
- **Rebobinar a este mensaje**: revierte las ediciones del agente y todos los turnos posteriores a ese punto, y restaura a la vez el proyecto, la conversación y el estado del agente.
- **Ediciones del proyecto**: un interruptor en **Ajustes de IA**. Cuando está desactivado, se rechaza toda edición que el agente intente: puede seguir leyendo el proyecto y describiendo el cambio que haría, pero no aplica nada hasta que vuelvas a activar el interruptor.

`Ctrl/Cmd + Z` deshace una edición del agente exactamente igual que una manual.

La opción **Cortes inteligentes** (marcada *Con IA*) del menú de mejora automática de la línea de tiempo es el mismo agente con una única instrucción. (La otra opción, **Zooms automáticos**, lee los clics grabados y no necesita ningún proveedor).

## Qué más usa tu proveedor {#what-else-uses-your-provider}

La [traducción de subtítulos](./captions.md#translation) es una sola llamada de transformación de texto al mismo modelo: no ejecuta el ciclo del agente y no puede tocar tu documento. La transcripción y el renderizado de los subtítulos se hacen por completo en tu equipo en cualquier caso.

## Usar Claude Code, Codex u otro cliente MCP {#using-claude-code-codex-or-another-mcp-client}

Si ya usas un agente de código con IA como Claude Code o Codex, puede manejar las mismas herramientas de edición, con la sesión iniciada en su propia cuenta. Nada de esa cuenta pasa por OpenScreen.

1. **Configuración de IA** → **Servidor MCP** → actívalo. Solo escucha en tu propio equipo (`127.0.0.1`), en el puerto que se muestra.
2. Copia el comando de **Claude Code** o de **Codex** que aparece ahí y ejecútalo en una terminal. El comando de Claude Code lleva el token de acceso. Codex, en cambio, lo lee de la variable de entorno `OPENSCREEN_MCP_TOKEN`: defínela en el shell desde el que inicias Codex.
3. Mantén un proyecto abierto en el editor de OpenScreen y luego pídele la edición a tu agente.

Las herramientas son las que usa el agente integrado, y actúan sobre el proyecto abierto en el editor. Los clientes MCP solo pueden **leer** el proyecto hasta que también actives **Ediciones del proyecto** en la sección Servidor MCP; este interruptor es independiente del del agente integrado, y empieza desactivado. Una vez activado, cada edición se guarda en cuanto se aplica y se deshace con `Ctrl/Cmd + Z`. A los clientes se les indica que guarden un punto de restauración antes de una serie de ediciones, así que puedes pedirles que dejen el proyecto como estaba en un solo paso, que el propio `Ctrl/Cmd + Z` puede deshacer. **Regenerar** el token desconecta a todos los clientes configurados con el anterior.

## Dejar que un agente haga todo el video {#letting-an-agent-make-the-whole-video}

El servidor de arriba edita proyectos. Para que un agente haga un video completo por sí solo, desde la grabación hasta la exportación, agrega en cambio OpenScreen al agente como servidor stdio: el agente inicia el propio ejecutable de la app con `mcp`. Obtiene las mismas herramientas de edición, además de `listSources`, `startRecording`, `stopRecording`, `setPointerTrack`, `exportVideo` y `getFrames`.

```bash
claude mcp add openscreen -- "/Applications/Openscreen.app/Contents/MacOS/Openscreen" mcp
codex mcp add openscreen -- "/Applications/Openscreen.app/Contents/MacOS/Openscreen" mcp
```

El ejecutable de cada sistema aparece en [Ejecutar la CLI](./cli.md#running-the-cli).

- **Sin puerto, sin token, sin ajuste.** El agente inicia el proceso él mismo, con tus permisos, como ejecutaría `openscreen record`. Así puede grabar tu pantalla y editar sin el interruptor **Ediciones del proyecto**.
- **Cada toma se convierte en un proyecto nuevo** en tu lista de proyectos, con un zoom en cada clic grabado, como una grabación hecha en la app. No lo edites en el editor mientras el agente siga trabajando en él: el editor conserva su propia copia.
- **Una toma controlada por un script** (Playwright, por ejemplo) nunca mueve el puntero de la pantalla. El agente le pasa a OpenScreen su propio registro de las acciones con `setPointerTrack`, y el video obtiene igualmente un cursor y sus zooms.
- **La skill `openscreen-demo`** le enseña a un agente todo el trabajo, desde el storyboard hasta el video terminado. Después adjunta el video a un pull request, para que los revisores vean el cambio ahí mismo, o redacta un post en X que solo publica cuando dices que sí. Agrégala con `npx skills add getopenscreen/openscreen --skill openscreen-demo`. La receta es [`skills/openscreen-demo/SKILL.md`](https://github.com/getopenscreen/openscreen/blob/main/skills/openscreen-demo/SKILL.md).
