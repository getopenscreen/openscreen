---
id: quick-start
title: Como gravar a tela com o OpenScreen
sidebar_label: Início rápido
sidebar_position: 3
description: "Grave, recorte e exporte sua primeira gravação de tela com o OpenScreen em seis passos, da abertura do HUD de gravação até um MP4 ou GIF pronto."
keywords:
  - tutorial de gravação de tela
  - início rápido
  - gravar a tela
  - cortar vídeo
  - exportar MP4
---

# Como gravar a tela com o OpenScreen

Este início rápido mostra como gravar, recortar e exportar seu primeiro vídeo. Se ainda não instalou o OpenScreen, veja antes a [Instalação](./installation.md).

## 1. Abra o HUD de gravação {#1-open-the-recording-hud}

Ao abrir o OpenScreen, aparece uma pequena cápsula flutuante (o HUD) fixada na parte de baixo da tela. Ela fica acima de tudo e não intercepta cliques até você interagir com ela.

## 2. Escolha o que gravar {#2-pick-what-to-record}

Clique no seletor de fonte (ícone de tela) para abrir a seleção de fontes. Ela lista suas **Telas** e **Janelas** em duas abas — escolha uma miniatura e clique em **Compartilhar**.

No Linux, o HUD não tem seletor de fonte. Ele mostra *O sistema perguntará o que compartilhar*: quando você aperta gravar, a própria caixa de diálogo de compartilhamento do seu ambiente de desktop pergunta qual tela ou janela usar, antes da contagem regressiva e de novo a cada tomada.

## 3. Ative o áudio e a webcam (opcional) {#3-turn-on-audio-and-webcam-optional}

No grupo de áudio do HUD, ative:
- **Áudio do sistema** — captura o que está tocando no seu computador.
- **Microfone** — abre um medidor de nível e um seletor de dispositivo para você confirmar que o microfone certo está selecionado.
- **Webcam** — abre um seletor de câmera; a webcam é gravada como uma faixa separada, que você posiciona depois no editor.

## 4. Grave {#4-record}

Clique no botão de gravar. Uma contagem regressiva 3‑2‑1 aparece sobre a área de trabalho, e então a gravação começa. Durante a gravação, você pode:
- **Pausar / Retomar**
- **Reiniciar** — descarta a tomada atual e começa de novo
- **Cancelar** — descarta sem salvar

Clique em **Parar** quando terminar.

## 5. Abra o Studio {#5-open-the-studio}

Clique em **Abrir Studio** (ou ele abre sozinho quando você encerra a gravação) para carregar sua gravação no editor.

## 6. Recorte e exporte {#6-trim-and-export}

- Posicione o cursor de reprodução onde quer um corte e pressione `T` (ou o botão de tesoura) — uma região de recorte de dois segundos aparece ali. Arraste as bordas dela para ajustar o que será removido.
- Clique em **Exportar** na barra superior, escolha **MP4** ou **GIF**, selecione uma qualidade e clique em **Exportar**.
- Quando terminar, clique em **Mostrar na pasta** para encontrar o arquivo.

Esse é o ciclo básico. Para o conjunto completo de ferramentas de edição — zooms, mudanças de velocidade, anotações, estilo do cursor, layout da webcam —, veja [Edição e linha do tempo](./editing-timeline.md). Para juntar várias tomadas em um só vídeo, veja [Biblioteca de mídia](./media-library.md).

:::note
A barra superior alterna o editor entre três modos: **Mídia** (seus clipes), **Editar** (tudo o que foi descrito acima) e **Gravar** (para preparar a próxima gravação sem sair do app).
:::

:::tip
Salve seu trabalho como projeto (`⌘/Ctrl S`) antes de exportar se quiser voltar e continuar editando depois — os arquivos de projeto `.openscreen` mantêm todas as camadas editáveis, ao contrário do vídeo exportado.
:::
