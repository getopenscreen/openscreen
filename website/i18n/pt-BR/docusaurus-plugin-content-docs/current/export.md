---
id: export
title: Exportar gravações de tela em MP4 ou GIF
sidebar_position: 9
sidebar_label: Exportação
description: "Exporte do OpenScreen em MP4 (720p, 1080p ou resolução de origem, H.264 ou H.265) ou GIF animado, e veja como a GPU renderiza e codifica em cada sistema."
keywords:
  - exportar MP4
  - H.264
  - H.265
  - GIF animado
  - exportar vídeo
  - 1080p
---

# Exportar gravações de tela em MP4 ou GIF

Clique em **Exportar** na barra superior para abrir a caixa de diálogo de exportação.

## Formatos {#formats}

- **MP4** — qualidade **Baixa** (720p), **Média** (1080p) ou **Alta** (resolução de origem); taxa de quadros de 24 / 30 / 60 fps; codec **H.264** (o padrão, e o aceito por mais players) ou **H.265**.
- **GIF** — taxa de quadros de 15 / 20 / 25 / 30 fps, tamanho Medium / Large / Original e a opção **Repetir GIF**.

:::note
O VP9 foi removido. Não há codificador VP9 por hardware nas GPUs para as quais o pipeline nativo foi feito, e a alternativa por software era lenta demais para ser oferecida como uma opção aparentemente equivalente às outras.
:::

## Resolução {#resolution}

A caixa de diálogo mostra o tamanho exato em pixels que cada nível de qualidade vai gerar, de acordo com a proporção da sua linha do tempo.

**Alta** (resolução de origem) se baseia no tamanho real do *menor* clipe, já com o corte da imagem aplicado, o que por construção impede ampliações: nenhum clipe da linha do tempo é esticado além da sua resolução real. Os níveis fixos **Baixa** (720p) e **Média** (1080p) miram um tamanho fixo para o lado menor, seja qual for o clipe, então ainda podem ampliar um clipe pequeno — a caixa de diálogo sinaliza o nível quando isso aconteceria.

## Como exportar {#exporting}

1. Configure o formato e a qualidade e clique em **Exportar**.
2. Escolha onde salvar na caixa de diálogo de arquivos do sistema.
3. A caixa de diálogo mostra o progresso real do codificador: quadros renderizados sobre o total, mais uma estimativa de tempo restante, e depois uma fase de gravação do arquivo.
4. Se der certo, **Mostrar na pasta** leva direto ao arquivo.

Se algo falhar durante a renderização ou a gravação, a caixa de diálogo mostra o erro para você tentar de novo.

## Como o MP4 é renderizado {#how-mp4-is-rendered}

A exportação MP4 passa pelo mesmo compositor nativo em Rust que desenha a pré-visualização ao vivo — Direct3D 11 no Windows, Metal no macOS, wgpu/WGSL no Linux —, um clipe por vez, em um único dispositivo de GPU: demux → decodificação → composição → codificação → mux. No Windows, os codificadores da AMD (AMF) e da NVIDIA (NVENC) recebem o quadro composto direto da GPU, sem cópia de volta para a CPU no meio; o Intel Quick Sync, o Media Foundation e a alternativa por software recebem uma cópia na memória do sistema. No macOS, quem codifica é o VideoToolbox: uma exportação H.264 é renderizada direto no buffer do próprio codificador quando o VideoToolbox permite, enquanto o caminho de nova tentativa do H.264, todas as exportações H.265 e a alternativa por software recebem uma cópia na memória do sistema. No Linux, uma exportação H.264 vai para o codificador da GPU via VAAPI, também sem cópia pela CPU, quando a pilha de drivers permite; caso contrário, e em todas as exportações H.265, o quadro é copiado de volta para a CPU e codificado por software. A pré-visualização se pausa durante a exportação para que as duas não disputem a GPU.

Como a pré-visualização e a exportação consomem a mesma descrição de cena, o quadro que você está vendo é o quadro que você recebe — não existe um renderizador de exportação separado que possa divergir.

:::note Suporte por plataforma
As exportações MP4 e GIF funcionam no Windows, no macOS e no Linux. O que muda é a velocidade no Linux: o H.264 só usa a GPU quando o VAAPI e o dispositivo Vulkan dão suporte, e o H.265 é sempre codificado por software, então essas exportações demoram mais nesse sistema. A nota [Exportação MP4 no Linux](./installation.md#platform-differences) lista o que o caminho pela GPU exige.
:::

## Arquivo exportado vs. arquivo de projeto {#exported-file-vs-project-file}

Exportar gera um vídeo (ou GIF) final, com as camadas mescladas — ele não pode mais ser editado. Se quiser continuar editando mais tarde, salve um **projeto** `.openscreen` (veja [Edição e linha do tempo](./editing-timeline.md#saving-your-work)); os arquivos de projeto mantêm intactos cada clipe, zoom, recorte, anotação e configuração.
