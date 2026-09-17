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

La opción **Cortes inteligentes** (marcada *Con IA*) del menú de mejora automática de la línea de tiempo es el mismo agente con una única instrucción. (La otra opción, **Zooms automáticos**, lee el movimiento grabado del cursor y no necesita ningún proveedor).

## Qué más usa tu proveedor {#what-else-uses-your-provider}

La [traducción de subtítulos](./captions.md#translation) es una sola llamada de transformación de texto al mismo modelo: no ejecuta el ciclo del agente y no puede tocar tu documento. La transcripción y el renderizado de los subtítulos se hacen por completo en tu equipo en cualquier caso.
