---
id: effects
title: Efectos personalizados
description: "Pide a un agente de IA un efecto visual que los ajustes no ofrecen. Escribe un shader de GPU que OpenScreen dibuja en la vista previa y en cada exportación."
keywords:
  - efectos de vídeo personalizados
  - efectos shader
  - WGSL
  - efectos de vídeo con IA
  - efectos GPU
---

# Efectos personalizados

Cuando los ajustes no tienen el aspecto que buscas, pídeselo a un agente: una onda en cada clic, una viñeta que respira, un fundido a negro en los últimos segundos. El agente escribe el efecto como un pequeño shader de GPU, y OpenScreen lo dibuja en la vista previa y en cada exportación, MP4 y GIF, en Windows, macOS y Linux.

Los efectos vienen de un agente: el chat integrado o un cliente MCP como Claude Code o Codex (consulta [Edición con IA](./ai-editing.md)). Una vez que el efecto está en el proyecto, lo ajustas tú mismo en el editor.

## Pedir un efecto {#asking-for-an-effect}

Describe lo que quieres ver, y cuándo: «una onda en cada clic», «fundido a negro en los dos últimos segundos, subtítulos incluidos». El agente escribe el efecto, lo coloca en la línea de tiempo y puede ver el resultado con `getFrames` sin exportar el vídeo.

Un efecto sabe dónde está el cursor y dónde cayó cada clic, dónde están la grabación y la cámara web en el vídeo tras los zooms y la disposición, y en qué momento está. Así, un halo puede seguir al ratón, y una onda puede salir de cada clic, allí donde el zoom lo haya llevado.

## En el editor {#in-the-editor}

Los efectos tienen su propia fila en la línea de tiempo, bajo los tramos de cámara a pantalla completa, en cuanto el proyecto tiene uno. Cada bloque lleva el nombre del efecto. Muévelo, cambia su tamaño, cópialo y pégalo o elimínalo como cualquier otra región, y `Ctrl/Cmd + Z` deshace el cambio. Solo se reproduce un efecto a la vez: pegar sobre otro efecto se rechaza.

Haz clic en un bloque para abrir su inspector:

- **Un control para cada ajuste** que el agente dio al efecto: un deslizador, un interruptor, un color o un punto.
- **Se aplica a**, dónde se dibuja el efecto:
  - **Imagen**, por defecto: la grabación, la cámara web, el cursor y el fondo, bajo tus anotaciones y subtítulos, que siguen legibles.
  - **Textos**: solo las anotaciones y los subtítulos.
  - **Ambos**: el cuadro entero, texto incluido, para un fundido a negro que también cubra los subtítulos.
- **Coste**: **Ligero**, **Medio**, **Pesado** o **Muy pesado** (consulta [más abajo](#cost)).
- **Código**: el shader, de solo lectura, con **Copiar código**. Para cambiarlo, pídeselo al agente.

Un efecto copiado y pegado en otro proyecto se lleva su código.

## Coste {#cost}

El coste se estima a partir del código, contando cuántas veces lee el efecto la imagen por cada píxel. El mismo código recibe el mismo nivel en todos los ordenadores. Nada se rechaza por su coste: cuanto más pesado es el efecto, más corto es el tramo que le conviene.

| Nivel | Efectos típicos | Conviene para |
|---|---|---|
| **Ligero** | viñeta, etalonaje, onda al hacer clic | todo el vídeo |
| **Medio** | aberración cromática, desenfoque pequeño, glitch | unas decenas de segundos |
| **Pesado** | desenfoque fuerte, bokeh | una transición, un momento destacado |
| **Muy pesado** | raymarching, simulaciones | unos segundos: la exportación sigue siendo exacta pero más lenta, y la vista previa puede ralentizarse en una GPU pequeña |

## Si un efecto no compila {#if-an-effect-doesnt-compile}

El código de un agente se compila antes de aceptar el efecto. El código que falla se rechaza con el error del compilador, y el proyecto no cambia.

Un proyecto abierto en otro ordenador aún puede toparse con un compilador que no está de acuerdo. El efecto entonces no se dibuja, su inspector muestra **No compila en este ordenador** con el error, y la exportación continúa sin él.

## Proyectos de otras personas {#projects-from-someone-else}

Un proyecto lleva el código de sus efectos, así que abrir el proyecto de otra persona ejecuta código que no escribiste tú. Ese código solo se ejecuta en la GPU, sin acceso a tus archivos, a la red ni a la memoria de la app.

## Para autores de agentes {#for-agent-authors}

Las herramientas son `addEffect`, `setEffect`, `setEffectDefinition` y `getEffect`, y `removeModifier` quita un efecto. El contrato completo, es decir, la función `effect(uv)`, lo que puede leer y sus reglas, es el recurso MCP `openscreen://effects/contract`.
