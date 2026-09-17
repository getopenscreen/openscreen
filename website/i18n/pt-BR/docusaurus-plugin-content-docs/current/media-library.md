---
id: media-library
title: Biblioteca de mídia e clipes
sidebar_position: 5
description: "Gerencie fontes e clipes no OpenScreen: importe vídeos, recorte, corte a imagem, divida e reordene clipes na linha do tempo e defina o tamanho de saída."
keywords:
  - biblioteca de mídia
  - clipes de vídeo
  - cortar vídeo
  - recortar vídeo
  - dividir clipes
  - linha do tempo
---

# Biblioteca de mídia e clipes

Um projeto não é uma única gravação — é um conjunto de fontes e uma lista ordenada de clipes tirados delas. O modo **Mídia** é onde você gerencia as fontes; a fileira de clipes na parte de baixo da linha do tempo é onde você organiza os clipes.

## Modo Mídia {#media-mode}

Mude para **Mídia** na barra superior. A área principal mostra um cartão para cada fonte do projeto, com uma caixa de busca acima deles.

Selecione um cartão para abrir o painel de detalhes dele:

- **Transcrição da Fonte** — o texto completo daquele arquivo, com o status (Sem transcrição / Transcrição pendente / Baixando modelo de voz / Iniciando modelo de voz / Transcrevendo / Transcrição pronta / Nenhuma fala detectada / Sem faixa de áudio / Falha na transcrição) e o idioma detectado.
- **Regenerar em** — roda de novo o Whisper local para esse arquivo, seja com a detecção em **Automático**, seja forçando um dos 100 idiomas que o Whisper suporta.

**Importar mídia** adiciona um vídeo do disco. A caixa de diálogo de arquivos aceita `webm`, `mp4`, `mov`, `avi`, `mkv`, `m4v`, `wmv`, `flv` e `ts`. Esta área só recebe vídeo: músicas e outros arquivos de áudio entram pelo menu **Adicionar áudio** da barra de ferramentas da linha do tempo, e imagens entram como [anotações de imagem](./editing-timeline.md#annotations).

Importar uma fonte *não* a coloca na linha do tempo. Para isso, arraste o cartão dela para a fileira de clipes.

## Clipes na linha do tempo {#clips-on-the-timeline}

A fileira de baixo da linha do tempo é a faixa de clipes. Cada clipe mostra a própria forma de onda.

- **Arraste para reordenar.** As regiões acima acompanham o clipe delas — um zoom que você colocou em um clipe continua nesse clipe quando ele é movido.
- **Clique duplo** (ou o lápis em um clipe) abre **Editar clipe**: pontos de entrada/saída com um intervalo que pode ser percorrido, e um retângulo de corte com alças arrastáveis, campos numéricos X/Y/L/A e proporções predefinidas. O corte da imagem é por clipe.
- **Excluir clipe** remove o clipe da linha do tempo; a fonte continua na biblioteca de mídia.
- **Solte uma fonte sobre um clipe existente** e o OpenScreen pergunta onde ela entra: **Adicionar antes**, **Adicionar depois** ou **Dividir aqui e inserir** — que corta o clipe de destino no ponto em que ela foi solta e coloca a nova fonte no meio.

Os clipes são sempre contíguos — sem lacunas, sem sobreposições. Remover ou reordenar um clipe fecha o espaço que ele deixaria na régua.

## Tamanho de saída {#output-size}

O controle **Formato** na aba **Composição** define a proporção do quadro; **Original** lista as proporções reais dos clipes do projeto. Cada clipe é encaixado nesse quadro, então misturar uma gravação de tela 16:9 com uma captura de celular 9:16 na mesma linha do tempo funciona — a resolução gerada está em [Exportação](./export.md#resolution).

## Como começar um projeto {#starting-a-project}

**Novo projeto** pede um nome e um ponto de partida:

- **Gravação de tela** — vai direto para o [modo Gravar](./recording.md#recording-from-the-editor-rec-mode).
- **Importar mídia** — abre o seletor de arquivos.

**Abrir projeto** lista seus arquivos `.openscreen` recentes, com caixa de busca, navegação pelo teclado e a opção **Procurar arquivos…** como alternativa. Você também pode soltar um arquivo `.openscreen` no editor vazio.
