---
id: export
title: Exportar grabaciones de pantalla a MP4 o GIF
sidebar_position: 9
sidebar_label: Exportación
description: "Exporta desde OpenScreen a MP4 (720p, 1080p u origen, H.264 o H.265) o a GIF animado, y cómo funcionan el render y la codificación en GPU en cada sistema."
keywords:
  - exportar a MP4
  - H.264
  - H.265
  - GIF animado
  - exportar video
  - 1080p
---

# Exportar grabaciones de pantalla a MP4 o GIF

Haz clic en **Exportar** en la barra superior para abrir el cuadro de diálogo de exportación.

## Formatos {#formats}

- **MP4**: calidad **720p**, **1080p** o **Source**; 24 / 30 / 60 fotogramas por segundo; códec **H.264** (el predeterminado, y el que admiten más reproductores) o **H.265**.
- **GIF**: 15 / 20 / 25 / 30 fotogramas por segundo, tamaño Medium / Large / Original y un interruptor **Bucle de GIF**.

:::note
Se eliminó VP9. Las GPU a las que apunta el flujo nativo no tienen codificador VP9 por hardware, y el respaldo por software era excesivamente lento para ofrecerlo como una opción con el mismo aspecto que las demás.
:::

## Resolución {#resolution}

El cuadro de diálogo muestra el tamaño exacto en píxeles que producirá cada nivel de calidad, según la relación de aspecto de tu línea de tiempo.

**Source** ajusta el tamaño a la superficie real, una vez recortada, del clip *más pequeño*, así que por construcción nunca amplía: ningún clip de la línea de tiempo se estira más allá de su resolución real. Los niveles fijos de 720p y 1080p apuntan a un lado corto fijo, sea cual sea el clip, así que sí pueden ampliar un clip pequeño; el cuadro de diálogo marca el nivel cuando eso ocurriría.

## Exportar {#exporting}

1. Configura el formato y la calidad, y haz clic en **Exportar**.
2. Elige dónde guardar en el cuadro de diálogo de archivos del sistema.
3. El cuadro de diálogo muestra el progreso real del codificador: fotogramas renderizados sobre el total, más un tiempo estimado, y luego una fase de escritura.
4. Si todo sale bien, **Mostrar en la carpeta** te lleva directamente al archivo.

Si algo falla durante el renderizado o la escritura, el cuadro de diálogo muestra el error para que puedas volver a intentarlo.

## Cómo se renderiza el MP4 {#how-mp4-is-rendered}

La exportación MP4 pasa por el mismo compositor nativo en Rust que dibuja la vista previa en vivo (Direct3D 11 en Windows, Metal en macOS, wgpu/WGSL en Linux), un clip a la vez, en un único dispositivo GPU: demux → decodificación → composición → codificación → mux. En Windows, los codificadores de AMD (AMF) y NVIDIA (NVENC) toman el fotograma compuesto directamente de la GPU, sin copia intermedia a la CPU; Intel Quick Sync, Media Foundation y el respaldo por software reciben una copia en la memoria del sistema. En macOS codifica VideoToolbox: una exportación H.264 se renderiza directamente en el búfer propio del codificador cuando VideoToolbox lo permite, mientras que la ruta de reintento de H.264, todas las exportaciones H.265 y el respaldo por software reciben una copia en la memoria del sistema. En Linux, una exportación H.264 va al codificador de la GPU mediante VAAPI, también sin copia en la CPU, cuando la pila de controladores lo permite; en caso contrario, y en todas las exportaciones H.265, el fotograma se copia de vuelta a la CPU y se codifica por software. Mientras dura la exportación, la vista previa se pausa sola para que ambas no compitan por la GPU.

Como la vista previa y la exportación consumen la misma descripción de escena, el fotograma que estás viendo es el fotograma que obtienes: no hay un renderizador de exportación aparte que pueda divergir.

:::note Compatibilidad por plataforma
La exportación a MP4 y a GIF funciona en Windows, macOS y Linux. Lo que cambia es la velocidad en Linux: H.264 usa la GPU solo cuando VAAPI y el dispositivo Vulkan lo admiten, y H.265 siempre se codifica por software, así que esas exportaciones tardan más allí. La nota [Exportación MP4 en Linux](./installation.md#platform-differences) indica lo que necesita la ruta por GPU.
:::

## Archivo exportado frente a archivo de proyecto {#exported-file-vs-project-file}

Exportar produce un video (o un GIF) terminado y aplanado: después no se puede editar. Si quieres seguir editando más tarde, guarda en su lugar un **proyecto** `.openscreen` (consulta [Edición y línea de tiempo](./editing-timeline.md#saving-your-work)); los archivos de proyecto conservan intactos todos los clips, zooms, recortes, anotaciones y ajustes.
