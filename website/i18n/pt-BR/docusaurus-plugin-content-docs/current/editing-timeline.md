---
id: editing-timeline
title: Edição e linha do tempo
sidebar_position: 6
description: "Edite na linha do tempo do OpenScreen: regiões de zoom, recorte e velocidade, Câmera em Tela Cheia, anotações, estilo do cursor e inspetor flutuante."
keywords:
  - editor de vídeo com linha do tempo
  - regiões de zoom
  - rampa de velocidade
  - anotações
  - suavização do cursor
  - edição com várias faixas
---

# Edição e linha do tempo

O editor tem três modos, alternados pelo controle segmentado na barra superior:

| Modo | Para que serve |
|---|---|
| **Mídia** | Os clipes do projeto: importar, pesquisar, ver transcrições, arrastar para a linha do tempo. Veja [Biblioteca de mídia](./media-library.md). |
| **Editar** | A pré-visualização, o inspetor flutuante e a linha do tempo completa. É aqui que o projeto é realmente editado. |
| **Gravar** | Preparação de uma nova gravação — microfone, câmera, áudio do sistema, cursor. Veja [Gravação](./recording.md#recording-from-the-editor-rec-mode). |

Tudo o que vem abaixo descreve o modo **Editar**: uma pré-visualização redimensionável em cima e a linha do tempo embaixo. Arraste a alça entre as duas para redistribuir o espaço.

## Inspetor flutuante {#floating-inspector}

Uma barra flutuante de ícones fica sobre a pré-visualização. São cinco abas:

| Aba | O que controla |
|---|---|
| **Composição** | Uma seção de fundo (imagem, cor sólida ou gradiente atrás da gravação; envie sua própria imagem ou escolha uma predefinição), depois desfoque do fundo, sombra, desfoque de movimento, arredondamento dos cantos e espaçamento. A linha **Formato** define a proporção de saída da pré-visualização e da exportação: as proporções dos seus clipes em **Original**, além de 16:9, 9:16, 1:1, 4:3, 4:5, 16:10 e 10:16. |
| **Layout da câmera** | Composição da webcam: picture-in-picture, empilhamento vertical, quadro duplo ou sem webcam. Espelhamento, "encolher ao ampliar", formato da câmera (retângulo/círculo/quadrado/arredondado) e tamanho. Arraste a bolha da webcam direto no canvas para reposicioná-la. |
| **Áudio** | O nível de saída, aplicado da mesma forma na pré-visualização e na exportação. |
| **Cursor** | Só faz sentido para gravações feitas no modo de cursor editável, no Windows, no macOS ou no Linux. Mostrar/ocultar, recortar à tela, uma faixa de temas de cursor e controles deslizantes de tamanho, suavização, desfoque de movimento e rebote ao clicar. |
| **Transcrição** | A transcrição agregada de todos os clipes, editável — veja [Edição da transcrição](./captions.md#transcript-editing). O botão **Legendas** ativa as legendas, define o estilo delas e as traduz — veja [Legendas e transcrição](./captions.md#captions). |

O botão de **lápis** na mesma barra abre a janela **Editar clipe** para o clipe selecionado: um retângulo de corte arrastável com campos numéricos X/Y/L/A e proporções predefinidas, além dos pontos de entrada/saída do clipe. O corte da imagem é por clipe, não por projeto.

Selecionar uma região na linha do tempo (um bloco de zoom, recorte, anotação, velocidade ou Câmera em Tela Cheia) troca o conteúdo da aba por um inspetor dessa região, descrito abaixo junto com cada tipo de região.

## Barra de ferramentas da linha do tempo {#timeline-toolbar}

- **Melhoria automática** (ícone de varinha) — um menu com duas ações pontuais:
  - **Zooms automáticos** — lê o movimento gravado do cursor e coloca regiões de zoom nos momentos em que o cursor se detém. Sem rede, sem modelo. [Zoom automático](/features/auto-zoom/) explica como os momentos são escolhidos.
  - **Cortes inteligentes** (marcado *Com IA*) — em vez disso, passa o trabalho para o agente de IA, que precisa de um [provedor conectado](./ai-editing.md).
- **Velocidade** (`S`) — adiciona uma região de mudança de velocidade no cursor de reprodução.
- **Comentário** (`A`) — adiciona uma anotação no cursor de reprodução.
- **Recorte** (`T`) — coloca um corte de dois segundos ("região de recorte") no cursor de reprodução. Arraste as bordas para redimensioná-lo, como qualquer outra região.
- **Adicionar Zoom** (`Z`) — coloca uma região de zoom animada no cursor de reprodução.
- **Foco automático** (mira) — botão liga/desliga; quando ativado, todas as regiões de zoom seguem o cursor e o controle de foco de cada zoom fica travado.
- **Câmera em Tela Cheia** (`C`) — adiciona um segmento em que a webcam ocupa o quadro inteiro.

Arraste as bordas de uma região para redimensioná-la, ou arraste o bloco para movê-lo. As regiões se alinham ao cursor de reprodução, às bordas de outras regiões e ao início/fim da linha do tempo. `Ctrl/Cmd + C` / `Ctrl/Cmd + V` copia os atributos de uma região selecionada para outra região do mesmo tipo.

`Shift` + rolagem desloca a linha do tempo; `Ctrl`/`Cmd` + rolagem aproxima e afasta. Os dois aparecem como dicas abaixo da barra de reprodução.

### Regiões de zoom {#zoom-regions}

Clique em um bloco de zoom para abrir o inspetor dele:
- Seis níveis de profundidade predefinidos — 1.25× / 1.5× / 1.8× / 2.2× / 3.5× / 5×.
- **Rotação 3D** — Nenhuma, Iso, Esquerda ou Direita.
- **Modo de Foco** — Manual (arraste o marcador de foco na pré-visualização) ou Automático (segue o cursor gravado). Fica travado em Automático quando o botão Foco automático da barra de ferramentas está ativado.
- **Posição do Foco** — porcentagem X/Y numérica no modo manual.

As regiões de zoom colocadas por **Melhoria automática → Zooms automáticos** abrem o mesmo inspetor. Como essa ação funciona, e como ela se compara aos zooms automáticos de outros gravadores, está em [Zoom automático](/features/auto-zoom/).

### Regiões de recorte {#trim-regions}

Um trecho recortado é removido da reprodução e da exportação. O inspetor tem uma única ação, **Excluir Região de Recorte** — pressione `Del` ou use o botão do inspetor. Os mesmos cortes também podem ser feitos pelo texto, na [transcrição](./captions.md#transcript-editing).

### Regiões de velocidade {#speed-regions}

Uma lista de predefinições (de 0.25× a 5×, mais 1× para voltar ao normal) e um campo numérico livre que aceita qualquer valor até 100×. A exportação renderiza a velocidade real nos dois casos.

### Regiões de Câmera em Tela Cheia {#full-camera-regions}

Um trecho em que a webcam preenche o quadro em vez de ficar na caixa do layout — útil para uma introdução com você falando para a câmera no meio de uma gravação de tela. Só faz sentido quando a gravação tem uma faixa de webcam.

### Anotações {#annotations}

Quatro tipos, alternados pela lista **Tipo** no inspetor. Trocar o tipo mantém o trecho e a caixa da região, então uma escolha errada custa um clique, e não um redesenho.

- **Texto** — conteúdo, tamanho, cor de fundo com botão para ativar/desativar, cor do texto e uma animação de entrada (Nenhuma / Esmaecer / Subir / Aparecer / Deslizar à Esquerda / Máquina de Escrever / Pulsar).
- **Imagem** — envie um JPG, PNG, GIF ou WebP.
- **Seta** — oito direções, largura do traço (1–20) e cor.
- **Desfoque** — uma máscara de privacidade. Gaussiano ou Mosaico, retângulo ou oval, com intensidade (ou tamanho do bloco do mosaico). Arraste e redimensione sobre a pré-visualização, como qualquer outra anotação.

:::note
Não é mais possível desenhar formas de desfoque à mão livre. As que já existem continuam sendo renderizadas, mas como a caixa delimitadora delas — cobrindo mais do que o necessário, de propósito, em vez de deixar visível na exportação algo que você marcou como privado. O inspetor avisa quando encontra uma.
:::

## Estilo do cursor {#cursor-styling}

Se a gravação tem dados de cursor editável (captura nativa no modo de cursor editável, no Windows, no macOS ou no Linux; [Modo do cursor](./recording.md#cursor-mode) lista o que cada plataforma grava), a aba Cursor permite escolher em uma biblioteca de temas de cursor e ajustar tamanho, suavização, desfoque de movimento e rebote ao clicar independentemente da captura bruta — o trajeto do cursor é suavizado de forma determinística, então o que você vê na pré-visualização corresponde à exportação final.

## Atalhos de teclado {#keyboard-shortcuts}

O ícone de engrenagem na barra superior abre a janela de atalhos, onde é possível reatribuir os atalhos configuráveis.

| Ação | Padrão |
|---|---|
| Adicionar Zoom | `Z` |
| Adicionar Recorte | `T` |
| Adicionar Velocidade | `S` |
| Adicionar Anotação | `A` |
| Adicionar Câmera em Tela Cheia | `C` |
| Adicionar áudio | `M` |
| Gravar narração | `V` |
| Excluir Selecionado | `Ctrl/Cmd + D` |
| Reproduzir / Pausar | `Space` |
| Copiar atributos da região | `Ctrl/Cmd + C` |
| Colar atributos da região | `Ctrl/Cmd + V` |
| Abrir Aplicativo (funciona a partir de qualquer app) | `Ctrl/Cmd + Shift + O` |

Fixos (não podem ser reatribuídos):

| Ação | Atalho |
|---|---|
| Desfazer | `Ctrl/Cmd + Z` |
| Refazer | `Ctrl/Cmd + Shift + Z` (ou `+ Y`) |
| Excluir Selecionado (alt) | `Del` / `⌫` |
| Alternar Anotações (Próximo / Anterior) | `Tab` / `Shift + Tab` |
| Quadro Anterior / Próximo Quadro | `←` / `→` |
| Mover Linha do Tempo | `Shift + Scroll` |
| Zoom na Linha do Tempo | `Ctrl + Scroll` |

## Como salvar seu trabalho {#saving-your-work}

As edições ficam em um arquivo de projeto `.openscreen` — separado de qualquer vídeo exportado e totalmente reeditável:

- **Salvar Projeto** (`Ctrl/Cmd + S`) — salva no mesmo lugar ou, na primeira vez, pede um local.
- **Carregar Projeto** (`Ctrl/Cmd + O`) — abre um arquivo `.openscreen` existente.
- **Novo Projeto** (`Ctrl/Cmd + N`) — limpa o projeto atual.

A barra superior mostra um indicador **Salvo** / **Não salvo**, e fechar com alterações não salvas pede que você salve, descarte ou cancele.

Quando estiver pronto, siga para a [Exportação](./export.md).
