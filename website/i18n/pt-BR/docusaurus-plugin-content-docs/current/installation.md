---
id: installation
title: Instalar o OpenScreen no Windows, macOS e Linux
sidebar_label: Instalação
sidebar_position: 2
description: "Instale o OpenScreen pela Microsoft Store ou winget, .dmg notarizado no macOS ou .deb, .rpm, .pacman, AppImage e Nix no Linux, e veja os requisitos."
keywords:
  - instalar gravador de tela
  - baixar OpenScreen
  - Microsoft Store
  - winget
  - dmg macOS
  - instalador para Windows
  - deb Linux
  - rpm Fedora
  - AppImage
  - flake Nix
---

# Instalar o OpenScreen no Windows, macOS e Linux

No Windows, o caminho recomendado é a [Microsoft Store](#windows). Nos demais sistemas, baixe o instalador mais recente para a sua plataforma na [página de download](/download/) ou direto do [GitHub Releases](https://github.com/getopenscreen/openscreen/releases).

## Requisitos de sistema {#system-requirements}

| | Mínimo | Recomendado |
|---|---|---|
| **Windows** | Windows 10 versão 1903 (build 18362) ou posterior, x64, Intel de 8ª geração / AMD Ryzen série 2000 ou mais recente. A captura nativa exige o Windows 10 versão 2004 (build 19041) ou posterior; builds mais antigos gravam usando a [alternativa de captura pelo navegador](#platform-differences) | Windows 11, Intel de 12ª geração / AMD Ryzen série 4000 ou mais recente |
| **macOS** | macOS 13 (Ventura) — exigido pelo ScreenCaptureKit para a captura | macOS 14 ou posterior |
| **Linux** | x64. `xdg-desktop-portal` e PipeWire, necessários para gravar: o auxiliar de captura nativa passa por eles, e uma falha ali é informada como erro. A [alternativa de captura pelo navegador](#platform-differences) só entra em ação quando falta o próprio auxiliar no build. O áudio do sistema também exige o PipeWire como servidor de som (o padrão no [Ubuntu 22.10+](https://discourse.ubuntu.com/t/kinetic-kudu-release-notes/27976) e no [Fedora 34+](https://fedoraproject.org/wiki/Changes/DefaultPipeWire)). Gravar os cliques do mouse no Wayland exige que seu usuário esteja no grupo `input` — veja [Cliques do mouse no Wayland](#mouse-clicks-on-wayland) | O mesmo, mantido atualizado |
| **RAM** | 8 GB | 16 GB |

:::note Gráficos integrados mais antigos no Windows
Máquinas com gráficos integrados anteriores, aproximadamente, à 8ª geração da Intel (ou à série equivalente AMD Ryzen 2000) não são impedidas de instalar, mas algumas têm problemas conhecidos de estabilidade de driver que podem impedir uma gravação de parar e ser salva — veja [#460](https://github.com/getopenscreen/openscreen/issues/460). Se isso acontecer, abra o ícone da bandeja ou **Ajuda → Salvar Diagnósticos** logo após a falha (antes de iniciar outra gravação) e anexe o arquivo a um relatório de bug.
:::

## macOS {#macos}

Baixe o instalador `.dmg` em [Releases](https://github.com/getopenscreen/openscreen/releases) e arraste o OpenScreen para a pasta Aplicativos. Os builds a partir da 1.9.0 são assinados com um certificado Developer ID e notarizados pela Apple, então o Gatekeeper não os bloqueia e nenhum passo no terminal é necessário.

Depois, vá em **Ajustes do Sistema → Privacidade e Segurança** e conceda **Gravação de Tela** e **Acessibilidade** ao OpenScreen. A Gravação de Tela é o que permite qualquer captura. A Acessibilidade é necessária para que o cursor editável padrão grave o formato do cursor e os cliques: nesse modo, apertar gravar sem ela abre um aviso com um link para o ajuste, e a gravação começa quando você concede a permissão e aperta gravar de novo.

:::note No macOS 15 e posterior, o pedido volta de tempos em tempos
O macOS volta a pedir a permissão de gravação de tela de tempos em tempos para todo gravador de tela de terceiros. Esse pedido vem do sistema operacional — não significa que sua instalação esteja com defeito nem que uma atualização tenha dado errado. Conceda de novo quando for solicitado.
:::

:::tip Atualizando de uma versão anterior à 1.9.0?
Esses builds não eram assinados com um certificado Developer ID, e o macOS vincula as permissões de Gravação de Tela e Acessibilidade à assinatura do app — então ele não tem como saber que o novo build é o mesmo app, e as permissões concedidas ao antigo não são transferidas. Se uma nova versão não gravar mesmo depois de você concedê-las, remova as entradas do OpenScreen nas duas permissões em Ajustes do Sistema, abra o app de novo e conceda-as do zero.
:::

## Windows {#windows}

**Recomendado: Microsoft Store.** [Obtenha o OpenScreen na Microsoft Store](https://apps.microsoft.com/detail/9MXQ1HQJL5G5) ou instale o mesmo pacote pelo terminal:

```powershell
winget install --source msstore OpenScreen
```

A Microsoft assina o pacote da Store durante a certificação, então ele é instalado sem aviso de segurança, e a Store o mantém atualizado.

**Alternativa: instalador avulso.** Baixe e execute o `.exe` em [Releases](https://github.com/getopenscreen/openscreen/releases) se não puder usar a Store — Windows LTSC, uma máquina de trabalho com restrições, uma instalação offline ou uma versão antiga específica.

:::note Aviso do SmartScreen no .exe
O `.exe` não tem assinatura de código, então o Windows SmartScreen mostra **O Windows protegeu o computador** e informa um editor desconhecido. Escolha **Mais informações → Executar assim mesmo** para continuar. Baixe o `.exe` somente pela página de Releases; se quiser um pacote assinado, use a versão da Store.
:::

## Linux {#linux}

Quatro pacotes x64 são publicados a cada versão — escolha o da sua distribuição. Em aarch64, use o flake Nix abaixo, que compila a partir do código-fonte.

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

**Qualquer distribuição (AppImage)**
```bash
chmod +x Openscreen-Linux-*.AppImage
./Openscreen-Linux-*.AppImage
```

Se o AppImage não abrir e mostrar um erro de sandbox:
```bash
./Openscreen-Linux-*.AppImage --no-sandbox
```

**NixOS / Nix (flake)**

Para testar sem instalar:
```bash
nix run github:getopenscreen/openscreen
```

Para instalar no seu perfil de usuário:
```bash
nix profile install github:getopenscreen/openscreen
```

Como módulo de sistema do NixOS:
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

Quem usa o Home Manager pode usar `openscreen.homeManagerModules.default` com o mesmo `programs.openscreen.enable = true;`.

Dependendo do seu ambiente de desktop, pode ser necessário conceder permissão de gravação de tela.

### Cliques do mouse no Wayland {#mouse-clicks-on-wayland}

O Wayland não oferece nenhum portal para eventos de entrada, então o OpenScreen lê os pressionamentos do botão esquerdo direto da interface evdev do kernel (`/dev/input/event*`). Esses nós de dispositivo pertencem a `root:input`, então uma gravação só distingue um clique de um movimento comum do cursor quando seu usuário está no grupo `input`:

```bash
sudo usermod -aG input $USER
```

Encerre a sessão e entre de novo para que o novo grupo passe a valer. Nada quebra sem isso — a gravação funciona exatamente como antes, e cada amostra do cursor é simplesmente registrada como movimento.

O escopo é restrito de propósito: só o botão esquerdo do mouse (`BTN_LEFT`) é lido, nunca as teclas digitadas. Para desativar o leitor por completo, mesmo onde a permissão existe, defina `OPENSCREEN_DISABLE_CLICK_CAPTURE=1` no ambiente a partir do qual o OpenScreen é iniciado.

:::caution
O grupo `input` não se limita ao OpenScreen: qualquer programa executado com o seu usuário passa a poder ler todos os dispositivos de entrada, inclusive o teclado. Só se adicione se aceitar isso nesta máquina.
:::

**Touchpads:** só um clique físico — pressionar o touchpad até ele afundar — é registrado. **O toque para clicar não é**, porque a pilha de entrada do seu compositor (libinput) sintetiza esses toques para uso próprio e nunca os repassa ao dispositivo do kernel que o OpenScreen lê, então não há nada para ver na camada evdev. Um mouse, ou um touchpad com o toque para clicar desativado, registra todos os cliques.

## Diferenças entre plataformas {#platform-differences}

As ferramentas de edição são as mesmas em todos os sistemas — zooms, fundos, corte da imagem/recorte/velocidade, anotações, transcrição, legendas e projetos. Todos os formatos de exportação funcionam em todas as plataformas; o que muda é a **captura** e qual codificador a exportação MP4 no Linux pode usar:

| | macOS | Windows | Linux |
|---|---|---|---|
| Pipeline de captura | Nativo (ScreenCaptureKit) | Nativo (Windows Graphics Capture) no build 19041 e posteriores; captura pelo navegador em builds mais antigos ou sem o auxiliar | Nativo (PipeWire via portal ScreenCast); captura pelo navegador sem o auxiliar, perdendo a codificação por hardware e a telemetria do cursor |
| Temas de cursor personalizados / efeitos de clique | ✅ — cliques e formato do cursor exigem a permissão de Acessibilidade | ✅ | ✅ no Wayland — a captura de cliques exige o grupo `input` ([detalhes](#mouse-clicks-on-wayland)) |
| Webcam | Captura pelo navegador, salva em arquivo separado (continua funcionando como PiP) | Captura nativa, salva em arquivo separado | Captura pelo navegador, salva em arquivo separado (continua funcionando como PiP) |
| Áudio do sistema | Funciona sem configuração; pedido de permissão no macOS 14.2+ | Funciona sem configuração | Exige o PipeWire como servidor de som (padrão no Ubuntu 22.10+ e no Fedora 34+) |
| Exportação MP4 | ✅ | ✅ | ✅ — H.264 na GPU via VAAPI quando a pilha da GPU permite (veja a nota abaixo), por software nos demais casos; H.265 só por software |
| Exportação GIF | ✅ | ✅ | ✅ |
| Transcrição local | Metal (Apple Silicon) / CPU | Vulkan / CPU | Vulkan / CPU |

:::note Exportação MP4 no Linux
O compositor de GPU por trás da pré-visualização ao vivo e da exportação MP4 tem três backends — Direct3D 11 no Windows, Metal no macOS, wgpu/WGSL no Linux — e vem nos três builds. No Linux, uma exportação H.264 entrega cada quadro composto ao `h264_vaapi` sem cópia pela CPU quando o driver da GPU expõe VAAPI *e* o dispositivo Vulkan consegue repassar o quadro como dmabuf (`VK_KHR_external_memory_fd` e `VK_EXT_external_memory_dma_buf`). Quando falta qualquer um desses itens — nenhum render node, um driver sem VAAPI, um dispositivo Vulkan sem essas extensões —, a exportação recorre a um codificador por software e simplesmente demora mais; nada mais muda. As exportações H.265 sempre usam o codificador por software no Linux.
:::

O que o OpenScreen faz em cada sistema, e quando outra ferramenta atende melhor, está resumido nas páginas sobre [Windows](/screen-recorder-windows/), [Mac](/screen-recorder-mac/) e [Linux](/screen-recorder-linux/).

A seguir: o [Início rápido](./quick-start.md) mostra, passo a passo, sua primeira gravação.
