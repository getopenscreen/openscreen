---
id: installation
title: Instalar OpenScreen en Windows, macOS y Linux
sidebar_label: Instalación
sidebar_position: 2
description: "Instala OpenScreen con Microsoft Store o winget, el .dmg notarizado de macOS o .deb, .rpm, .pacman, AppImage y Nix en Linux, más los requisitos del sistema."
keywords:
  - instalar grabador de pantalla
  - descargar OpenScreen
  - Microsoft Store
  - winget
  - dmg para macOS
  - instalador para Windows
  - deb para Linux
  - rpm para Fedora
  - AppImage
  - flake de Nix
---

# Instalar OpenScreen en Windows, macOS y Linux

En Windows, la vía recomendada es [Microsoft Store](#windows). En los demás sistemas, descarga el instalador más reciente para tu plataforma desde la [página de descarga](/download/), o directamente desde [GitHub Releases](https://github.com/getopenscreen/openscreen/releases).

## Requisitos del sistema {#system-requirements}

| | Mínimo | Recomendado |
|---|---|---|
| **Windows** | Windows 10 versión 1903 (compilación 18362) o posterior, x64, Intel de 8.ª generación / AMD Ryzen serie 2000 o más reciente. La captura nativa necesita Windows 10 versión 2004 (compilación 19041) o posterior; las compilaciones anteriores graban con la [captura por navegador de respaldo](#platform-differences) | Windows 11, Intel de 12.ª generación / AMD Ryzen serie 4000 o más reciente |
| **macOS** | macOS 13 (Ventura), que ScreenCaptureKit exige para la captura | macOS 14 o posterior |
| **Linux** | x64. `xdg-desktop-portal` y PipeWire, que la grabación necesita: el módulo auxiliar de captura nativa pasa por ellos, y un fallo ahí se informa como error. La [captura por navegador de respaldo](#platform-differences) solo toma el relevo cuando a una compilación le falta el propio módulo auxiliar. El audio del sistema necesita además PipeWire como servidor de sonido (el predeterminado en [Ubuntu 22.10+](https://discourse.ubuntu.com/t/kinetic-kudu-release-notes/27976) y [Fedora 34+](https://fedoraproject.org/wiki/Changes/DefaultPipeWire)). Para grabar los clics del mouse en Wayland, tu usuario debe estar en el grupo `input`: consulta [Clics del mouse en Wayland](#mouse-clicks-on-wayland) | Lo mismo, actualizado |
| **RAM** | 8 GB | 16 GB |

:::note Gráficos integrados antiguos en Windows
Los equipos con gráficos integrados anteriores, aproximadamente, a la 8.ª generación de Intel (o a su equivalente, la serie AMD Ryzen 2000) no tienen bloqueada la instalación, pero algunos tienen problemas conocidos de estabilidad del controlador que pueden hacer que una grabación no logre detenerse y guardarse: consulta [#460](https://github.com/getopenscreen/openscreen/issues/460). Si te ocurre, abre el ícono de la bandeja o **Ayuda → Guardar diagnósticos** justo después del fallo (antes de iniciar otra grabación) y adjunta el archivo a un reporte de error.
:::

## macOS {#macos}

Descarga el instalador `.dmg` desde [Releases](https://github.com/getopenscreen/openscreen/releases) y arrastra OpenScreen a tu carpeta Aplicaciones. Las compilaciones a partir de la 1.9.0 están firmadas con un certificado Developer ID y notarizadas por Apple, así que Gatekeeper no las bloquea y no hace falta ningún paso en la terminal.

Después, ve a **Ajustes del Sistema → Privacidad y seguridad** y concede a OpenScreen los permisos **Grabación de pantalla** y **Accesibilidad**. Sin Grabación de pantalla, no puede capturar nada. Accesibilidad es lo que necesita el cursor editable predeterminado para registrar la forma del cursor y los clics: en ese modo, si presionas grabar sin haberlo concedido, se abre un aviso con un enlace al ajuste, y la grabación empieza cuando lo concedes y vuelves a presionar grabar.

:::note macOS 15 y posteriores vuelven a pedir el permiso periódicamente
macOS vuelve a solicitar de vez en cuando el permiso de grabación de pantalla para todos los grabadores de pantalla de terceros. Ese aviso lo muestra el sistema operativo: no significa que tu instalación esté dañada ni que una actualización haya fallado. Concédelo de nuevo cuando te lo pida.
:::

:::tip ¿Actualizas desde una versión anterior a la 1.9.0?
Esas compilaciones no estaban firmadas con un certificado Developer ID, y macOS asocia los permisos de Grabación de pantalla y Accesibilidad a la firma de la app. Por eso no puede saber que la nueva compilación es la misma app, y los permisos que concediste a la anterior no se conservan. Si una versión nueva no graba ni siquiera después de concederlos, elimina las entradas de OpenScreen en ambos permisos en Ajustes del Sistema, luego vuelve a abrir la app y concédelos de nuevo.
:::

## Windows {#windows}

**Recomendado: Microsoft Store.** [Obtén OpenScreen en Microsoft Store](https://apps.microsoft.com/detail/9MXQ1HQJL5G5), o instala el mismo paquete desde una terminal:

```powershell
winget install --source msstore OpenScreen
```

Microsoft firma el paquete de la Store durante la certificación, así que se instala sin advertencia de seguridad, y la Store lo mantiene actualizado.

**Alternativa: instalador independiente.** Descarga y ejecuta el `.exe` desde [Releases](https://github.com/getopenscreen/openscreen/releases) si no puedes usar la Store: Windows LTSC, un equipo de trabajo con restricciones, una instalación sin conexión o una versión anterior específica.

:::note Advertencia de SmartScreen con el .exe
El `.exe` no tiene firma de código, así que Windows SmartScreen muestra **Windows protegió su PC** e indica que el editor es desconocido. Elige **Más información → Ejecutar de todas formas** para continuar. Descarga el `.exe` solo desde la página de Releases; si quieres un paquete firmado, usa la versión de la Store.
:::

## Linux {#linux}

Cada versión publica cuatro paquetes x64: elige el que corresponda a tu distribución. En aarch64, usa el flake de Nix que aparece más abajo, que compila desde el código fuente.

**Debian / Ubuntu / Pop!_OS**
```bash
sudo apt install ./Openscreen-Linux-*.deb
```

**Fedora / RHEL / CentOS**
```bash
sudo dnf install ./Openscreen-Linux-*.rpm
```

**Arch / Manjaro**
```bash
sudo pacman -U Openscreen-Linux-*.pacman
```

**Cualquier distribución (AppImage)**
```bash
chmod +x Openscreen-Linux-*.AppImage
./Openscreen-Linux-*.AppImage
```

Si el AppImage no se abre por un error del sandbox:
```bash
./Openscreen-Linux-*.AppImage --no-sandbox
```

**NixOS / Nix (flake)**

Pruébalo sin instalarlo:
```bash
nix run github:getopenscreen/openscreen
```

Instálalo en tu perfil de usuario:
```bash
nix profile install github:getopenscreen/openscreen
```

Como módulo de sistema de NixOS:
```nix
{
  inputs.openscreen.url = "github:getopenscreen/openscreen";

  outputs = { nixpkgs, openscreen, ... }: {
    nixosConfigurations.<host> = nixpkgs.lib.nixosSystem {
      modules = [
        openscreen.nixosModules.default
        { programs.openscreen.enable = true; }
      ];
    };
  };
}
```

Los usuarios de Home Manager pueden usar `openscreen.homeManagerModules.default` con el mismo `programs.openscreen.enable = true;`.

Según tu entorno de escritorio, puede que tengas que conceder el permiso de grabación de pantalla.

### Clics del mouse en Wayland {#mouse-clicks-on-wayland}

Wayland no ofrece ningún portal para los eventos de entrada, así que OpenScreen lee las pulsaciones del botón izquierdo directamente de la interfaz evdev del kernel (`/dev/input/event*`). Esos nodos de dispositivo pertenecen a `root:input`, por lo que una grabación solo distingue un clic de un movimiento normal del cursor cuando tu usuario está en el grupo `input`:

```bash
sudo usermod -aG input $USER
```

Cierra la sesión y vuelve a iniciarla para que el nuevo grupo surta efecto. Sin él no se rompe nada: la grabación funciona exactamente igual que antes, y cada muestra del cursor se registra simplemente como un movimiento.

El alcance es deliberadamente limitado: solo se lee el botón izquierdo del mouse (`BTN_LEFT`), nunca las pulsaciones de teclas. Para desactivar el lector por completo, incluso donde existe el permiso, define `OPENSCREEN_DISABLE_CLICK_CAPTURE=1` en el entorno desde el que se inicia OpenScreen.

:::caution
El grupo `input` no se limita a OpenScreen: cualquier programa que se ejecute con tu usuario puede leer entonces todos los dispositivos de entrada, incluido el teclado. Agrégate solo si lo aceptas en esta máquina.
:::

**Touchpads:** solo se registra un clic físico, es decir, presionar el touchpad hasta que se hunda. **Tocar para hacer clic no se registra**, porque la pila de entrada de tu compositor (libinput) sintetiza esos toques para su propio uso y nunca los vuelve a escribir en el dispositivo del kernel que lee OpenScreen, así que en la capa evdev no hay nada que ver. Un mouse, o un touchpad con tocar para hacer clic desactivado, registra todos los clics.

## Diferencias entre plataformas {#platform-differences}

Las herramientas de edición son las mismas en todas partes: zooms, fondos, encuadre/recorte/velocidad, anotaciones, transcripción, subtítulos y proyectos. Todos los formatos de exportación funcionan en todas las plataformas; lo que cambia es la **captura**, y qué codificador puede usar la exportación MP4 en Linux:

| | macOS | Windows | Linux |
|---|---|---|---|
| Flujo de captura | Nativo (ScreenCaptureKit) | Nativo (Windows Graphics Capture) en la compilación 19041 y posteriores; respaldo por navegador en compilaciones anteriores o sin el módulo auxiliar | Nativo (PipeWire mediante el portal ScreenCast); respaldo por navegador sin el módulo auxiliar, con lo que se pierden la codificación por hardware y la telemetría del cursor |
| Temas de cursor personalizados / efectos de clic | ✅ (los clics y la forma del cursor necesitan el permiso de Accesibilidad) | ✅ | ✅ en Wayland (la captura de clics necesita el grupo `input`, [detalles](#mouse-clicks-on-wayland)) |
| Cámara web | Captura por navegador, guardada como archivo aparte (sigue funcionando como PiP) | Captura nativa, guardada como archivo aparte | Captura por navegador, guardada como archivo aparte (sigue funcionando como PiP) |
| Audio del sistema | Funciona sin configurar nada; aviso de permiso en macOS 14.2+ | Funciona sin configurar nada | Necesita PipeWire como servidor de sonido (predeterminado en Ubuntu 22.10+, Fedora 34+) |
| Exportación MP4 | ✅ | ✅ | ✅: H.264 en la GPU mediante VAAPI cuando la pila gráfica lo permite (consulta la nota más abajo), por software en caso contrario; H.265 solo por software |
| Exportación GIF | ✅ | ✅ | ✅ |
| Transcripción en el equipo | Metal (Apple Silicon) / CPU | Vulkan / CPU | Vulkan / CPU |

:::note Exportación MP4 en Linux
El compositor GPU que hay detrás de la vista previa en vivo y de la exportación MP4 tiene tres backends (Direct3D 11 en Windows, Metal en macOS, wgpu/WGSL en Linux) y se incluye en las tres compilaciones. En Linux, una exportación H.264 entrega cada fotograma compuesto a `h264_vaapi` sin copia en la CPU cuando el controlador de la GPU expone VAAPI *y* el dispositivo Vulkan puede entregar el fotograma como dmabuf (`VK_KHR_external_memory_fd` y `VK_EXT_external_memory_dma_buf`). Cuando falta cualquiera de esas cosas (no hay nodo de renderizado, el controlador no tiene VAAPI, el dispositivo Vulkan no tiene esas extensiones), la exportación recurre a un codificador por software y simplemente tarda más; nada más cambia. En Linux, las exportaciones H.265 siempre usan el codificador por software.
:::

Lo que hace OpenScreen en cada sistema, y cuándo otra herramienta encaja mejor, se resume en las páginas de [Windows](/screen-recorder-windows/), [Mac](/screen-recorder-mac/) y [Linux](/screen-recorder-linux/).

Siguiente: [Inicio rápido](./quick-start.md) te guía en tu primera grabación.
