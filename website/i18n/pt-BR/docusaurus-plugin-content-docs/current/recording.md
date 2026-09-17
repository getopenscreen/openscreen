---
id: recording
title: Gravação de tela
sidebar_position: 4
sidebar_label: Gravação
description: "Grave uma janela ou a tela inteira com o HUD do OpenScreen: áudio do sistema, microfone, webcam, modos de cursor, contagem regressiva e captura nativa."
keywords:
  - gravar tela
  - captura de janela
  - gravação de áudio do sistema
  - gravação de webcam
  - ScreenCaptureKit
  - Windows Graphics Capture
  - PipeWire
---

# Gravação de tela

A gravação acontece pelo **HUD** — uma cápsula sobreposta, que pode ser arrastada e fica sempre em primeiro plano. Ela ignora cliques do mouse em todo lugar, exceto nos próprios controles, então nunca atrapalha o app que você está gravando.

## Como escolher uma fonte {#choosing-a-source}

O botão do seletor de fonte mostra a tela ou janela selecionada no momento (com o nome abreviado) e fica desativado quando a gravação começa. Clicar nele abre uma janela separada com duas abas:

- **Telas** — um cartão por monitor.
- **Janelas** — um cartão por janela aberta, com o ícone do app.

Escolha uma miniatura e clique em **Compartilhar**. Se nenhuma fonte estiver selecionada quando você apertar gravar, o OpenScreen abre o seletor primeiro e começa a gravar automaticamente assim que você escolher uma.

Não há captura de região: você grava uma tela inteira ou uma janela e corta a imagem depois, clipe por clipe, no editor.

No Linux, o HUD não mostra seletor de fonte, apenas *O sistema perguntará o que compartilhar*. Quem faz essa escolha é o portal ScreenCast: apertar gravar abre a caixa de diálogo de compartilhamento do seu ambiente de desktop antes da contagem regressiva, e ela pergunta de novo a cada tomada.

## Áudio {#audio}

Três botões de ativação ficam em um único grupo de controles:

- **Áudio do sistema** — captura o que está tocando no computador. Fica desativado quando a gravação começa.
- **Microfone** — ativá-lo (com a gravação parada) abre um popup com um medidor de nível de áudio ao vivo, de 5 barras, e uma lista de todos os dispositivos de entrada disponíveis, para você confirmar o microfone certo antes de começar.
- **Webcam** — ativá-la mostra um seletor de câmera com os estados esperados (procurando, indisponível, nenhuma câmera encontrada). A webcam é gravada como faixa própria, composta depois no editor.

O suporte a áudio do sistema depende do seu sistema operacional — veja as [diferenças entre plataformas](./installation.md#platform-differences).

## Modo do cursor {#cursor-mode}

No Windows, no macOS e no Linux, um botão de modo do cursor alterna entre:
- **Sobreposição editável** (padrão) — o cursor do sistema não entra na imagem gravada, e o movimento dele é gravado como dados, para que o OpenScreen desenhe um cursor que você pode personalizar com temas, redimensionar e animar no editor.
- **Sistema** — grava o cursor do sistema como ele é, sem edição.

O que a sobreposição editável captura depende da plataforma:
- **Windows** — o formato real do cursor e os cliques.
- **macOS** — o formato do cursor e os cliques, que exigem a permissão de Acessibilidade. Nesse modo, apertar gravar sem ela abre um aviso com link para o ajuste, em vez de começar a gravar (veja a [instalação no macOS](./installation.md#macos)).
- **Linux** — posição e formato pelo portal ScreenCast, além dos cliques com o botão esquerdo quando seu usuário está no grupo `input` (veja [Cliques do mouse no Wayland](./installation.md#mouse-clicks-on-wayland)).

Uma tomada no Linux que recorre à [captura pelo navegador](#native-vs-browser-capture) grava o cursor do sistema, seja qual for o modo escolhido.

## Controles de gravação {#recording-controls}

- **Gravar / Parar** — uma cápsula que, fora da gravação, mostra o nome da fonte ao passar o mouse e, durante a gravação, um cronômetro `mm:ss` ao vivo (o fundo fica âmbar quando a gravação está pausada).
- **Pausar / Retomar** — disponível durante a gravação.
- **Reiniciar** — descarta a tomada atual e começa do zero.
- **Cancelar** — descarta a tomada atual sem salvar.
- **Abrir Studio** — muda para o editor (oculto durante a gravação).

## Contagem regressiva {#countdown}

Apertar gravar dispara uma contagem regressiva 3‑2‑1, exibida em sobreposição a toda a área de trabalho, antes de a captura começar de fato.

## Outros controles do HUD {#other-hud-controls}

- **Alternância de layout** — alterna o HUD entre horizontal e vertical, e a escolha é mantida entre sessões.
- **Configurações** — ajustes do microfone e da câmera selecionados, sem sair do HUD.
- **Notas** (exceto no Linux) — abre uma pequena janela de rascunho com texto formatado, útil para um roteiro ou uma lista de deixas enquanto você grava. Ela é salva localmente entre sessões.
- **Idioma** — um seletor de idioma (13 idiomas) que só afeta a interface do OpenScreen, não a sua gravação.
- Controles de janela para ocultar o HUD ou fechar o app.

## Gravar pelo editor (modo Gravar) {#recording-from-the-editor-rec-mode}

Você não precisa começar pelo HUD. No editor, mude a barra superior para **Gravar** para ter uma página de preparação em tamanho completo, em vez de uma cápsula:

- **Fonte** — o mesmo seletor de tela/janela, em uma janela modal. No Linux, essa linha também mostra *O sistema perguntará o que compartilhar*, e a caixa de diálogo do portal faz a escolha.
- **Áudio do sistema**, **Microfone**, **Câmera** — cada um é uma linha de ativar/desativar; o microfone e a câmera se expandem em uma lista de dispositivos, e a câmera mostra uma pré-visualização ao vivo para você se enquadrar antes de começar.
- **Destaque do cursor** — ativado significa o cursor da sobreposição editável; desativado significa o cursor comum do sistema.

**Iniciar gravação** abre o widget de gravação e fecha a janela do editor; cancelar leva você de volta ao modo Editar. É também aqui que **Novo projeto → Gravação de tela** leva você.

## Captura nativa vs. pelo navegador {#native-vs-browser-capture}

Todas as plataformas gravam a tela por um auxiliar nativo: ScreenCaptureKit no macOS, Windows Graphics Capture no Windows 10 build 19041 e posteriores, e PipeWire pelo portal ScreenCast no Linux. A webcam é capturada de forma nativa só no Windows; o macOS e o Linux a gravam pelo navegador. Nos três, ela é salva em um arquivo separado e composta no editor.

A captura pelo navegador só substitui o auxiliar nativo em builds do Windows anteriores ao 19041, ou quando falta o auxiliar em um build para Windows ou Linux. Um auxiliar nativo que falha não recorre a ela: a gravação informa o erro. Veja a [tabela completa de diferenças entre plataformas](./installation.md#platform-differences).

Depois de parar a gravação, vá para [Edição e linha do tempo](./editing-timeline.md) para dar forma a ela — ou para a [Biblioteca de mídia](./media-library.md), se estiver juntando várias tomadas.
