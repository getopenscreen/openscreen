---
id: product-demo-video
title: Como fazer um vídeo de demonstração de produto
sidebar_label: Vídeo de demonstração
description: "Faça um vídeo demo de produto no OpenScreen: escreva o roteiro, grave a 60 fps, adicione webcam, zooms automáticos, cortes, desfoque e legendas, e exporte."
keywords:
  - vídeo de demonstração de produto
  - como gravar demo de software
  - vídeo demo com zoom e legendas
  - tutorial de gravação de tela
  - teleprompter
---

# Como fazer um vídeo de demonstração de produto

Para fazer um vídeo de demonstração de produto, escreva um roteiro curto, grave o produto em um ritmo constante e depois edite: corte o tempo morto, dê zoom no que importa, esconda dados privados, adicione legendas e exporte no formato de que o seu canal precisa. Este guia mostra cada etapa no OpenScreen, um gravador de tela e editor gratuito, com licença MIT, para Windows, macOS e Linux, em que a gravação, a edição, a transcrição e a exportação rodam no seu computador. O OpenScreen gera um arquivo de vídeo. Ele não hospeda o vídeo nem cria um tour clicável; se você precisa de um dos dois, veja [Quando o OpenScreen não é a ferramenta certa](#when-openscreen-is-not-the-right-tool).

## Antes de começar {#before-you-start}

- Instale o OpenScreen pela [página de download](/download/). A [Instalação](../installation.md) cobre cada plataforma.
- Decida onde o vídeo será assistido. Isso define o formato: 16:9 para um site ou uma página de documentação, 9:16 para um feed vertical, 1:1 para um espaço quadrado.
- Prepare o produto: uma conta de demonstração, dados de exemplo, notificações desativadas.

## 1. Escreva o roteiro na janela de notas {#1-write-the-script-in-the-notes-window}

No Windows e no macOS, clique em **Abrir notas** no HUD. Isso abre uma janela de texto formatado que é salva localmente entre sessões. Escreva o roteiro ali, uma ação por linha. O HUD do Linux não tem o botão de notas.

A janela de notas também serve de teleprompter. **Iniciar rolagem automática** rola o texto em uma velocidade de 10 a 100. O tamanho da fonte vai de 14 a 48 px, e **Espelhar horizontalmente** inverte o texto.

:::caution
No Windows, o OpenScreen mantém o HUD e a janela de notas fora da captura. No macOS, ele não consegue garantir isso, então deixe a janela de notas em um monitor que você não esteja gravando. No macOS e no Linux, use **Ocultar HUD** se o HUD estiver na tela gravada.
:::

## 2. Grave a tela ou uma janela {#2-record-the-screen-or-a-window}

1. No Windows e no macOS, abra o seletor de fonte e escolha uma tela em **Telas** ou uma única janela em **Janelas**. No Linux não há seletor no app: o portal do sistema pede a fonte a cada tomada. O OpenScreen não tem captura de região, então grave a janela ou a tela e depois corte a imagem do clipe no editor.
2. Ative o microfone e confira o medidor de nível. Ative o áudio do sistema se o produto emitir som, e a webcam se você quiser aparecer na tela.
3. Mantenha o modo de cursor editável, que é o padrão: o ponteiro é gravado como dados, então você pode mudar o estilo dele depois. Os cliques são gravados no Windows. No macOS, eles exigem a permissão de Acessibilidade. No Linux, seu usuário precisa estar no grupo `input`, e o toque para clicar do touchpad não é capturado ([detalhes](../installation.md#mouse-clicks-on-wayland)).
4. Aperte gravar. Uma contagem regressiva 3-2-1 roda antes e não pode ser desativada.

O OpenScreen captura com uma meta de 60 fps, até 3840×2160 no Windows e no macOS. No Linux, o tamanho é o que o compositor entregar. Durante a gravação, você pode pausar, reiniciar a tomada, cancelá-la ou parar.

**Ritmo para os zooms.** Leve o ponteiro até o que você vai explicar e deixe-o parado. Os zooms automáticos do passo 4 procuram essas pausas: um ponteiro parado por cerca de meio segundo até 2,6 segundos. Um ponteiro que fica parado por mais tempo que isso não recebe zoom.

**Demos longas no Linux.** O Linux grava um MP4 comum, que só é finalizado quando você para, então um travamento no meio da tomada deixa um arquivo ilegível. Em vez disso, grave várias tomadas mais curtas; o passo 5 mostra como juntá-las.

Todos os controles do HUD estão em [Gravação](../recording.md).

## 3. Escolha o layout da webcam e o fundo {#3-choose-the-webcam-layout-and-background}

A webcam é gravada em um arquivo próprio, então a posição dela é uma decisão de edição que você pode mudar a qualquer momento. Abra a aba **Layout da câmera** no inspetor do editor:

- **Picture in Picture**, **Empilhamento Vertical**, **Quadro Duplo** ou **Sem Webcam**.
- Em todos os layouts: espelhamento e um enquadramento da imagem da câmera.
- Só em **Picture in Picture**: **Formato da Câmera** (Ret., Círculo, Quadrado ou Arredondado), um tamanho de 10 a 50% (25% por padrão) e **Encolher ao ampliar**, ativado por padrão, que deixa a câmera menor enquanto um zoom é exibido, para que ela não cubra o detalhe. Arraste a câmera no canvas para movê-la.
- **Plano de fundo da câmera**: Original, Desfocado, Recorte ou Personalizado. Recorte remove o fundo sem tela verde, usando um modelo de segmentação que roda na sua CPU. Esta seção só aparece quando o runtime de segmentação carrega no seu computador.

Para uma introdução ou um encerramento, pressione `C` para adicionar um segmento de **Câmera em Tela Cheia**: a câmera preenche o quadro inteiro nesse trecho.

A aba **Composição** define o estilo do quadro. A seção de fundo oferece 18 papéis de parede integrados, uma cor sólida, um gradiente ou a sua própria imagem, além de um desfoque do fundo. Abaixo dela ficam sombra, arredondamento, espaçamento e desfoque de movimento.

## 4. Adicione zooms automáticos {#4-add-automatic-zooms}

Na barra de ferramentas da linha do tempo, abra **Melhoria automática** e escolha **Zooms automáticos**. O OpenScreen lê o movimento gravado do cursor e coloca regiões de zoom nessas pausas, sem rede e sem modelo. Se não colocar nenhuma, ele avisa. As causas mais comuns são uma gravação sem dados de cursor, nenhuma pausa naquele intervalo ou zooms existentes que já cobrem esses momentos.

Depois, revise os zooms. Clique em um zoom para definir o nível (de 1.25× a 5×), o modo de foco (Automático segue o cursor, Manual mantém um ponto fixo) e uma rotação 3D opcional. Pressione `Z` para adicionar um zoom manualmente e `Ctrl/Cmd+D` para excluir um que você não quiser.

Mais sobre como os zooms são posicionados: [Zoom automático](/features/auto-zoom/).

## 5. Corte pela transcrição e acelere o tempo morto {#5-cut-from-the-transcript-and-speed-up-dead-time}

**Transcreva primeiro.** Abra a aba **Transcrição**. Se ainda não houver uma transcrição, clique em **Transcrever agora**. A transcrição roda localmente com o Whisper. A primeira execução baixa o modelo uma única vez, cerca de 264 MB.

**Corte pelo texto.** Na transcrição, selecione palavras e pressione `Delete`: esse trecho é cortado da reprodução e da exportação. Os silêncios aparecem no texto como marcadores: clique em um para cortá-lo e clique de novo para restaurá-lo. Passe o mouse sobre uma palavra cortada para restaurá-la. Você também pode pressionar `T` para adicionar uma região de recorte na linha do tempo.

**Acelere o que não dá para cortar**, como carregamentos de página ou digitação. Pressione `S` para adicionar uma região de velocidade e escolha uma predefinição de 0.25× a 5× ou digite qualquer valor de 0.1× a 100×. O áudio é esticado no tempo para acompanhar.

**Junte várias tomadas.** Mude para **Mídia**, use **Importar mídia** se uma tomada ainda não estiver na lista e arraste o cartão dela para a fileira de clipes. Se você soltar o cartão sobre um clipe existente, o app oferece **Adicionar antes**, **Adicionar depois** ou **Dividir aqui e inserir**. Veja [Biblioteca de mídia](../media-library.md).

Se você conectou seu próprio provedor de LLM, **Melhoria automática → Cortes inteligentes** passa os cortes para o agente de IA. É opcional e fica desativado até você adicionar uma chave ([Edição com IA](../ai-editing.md)). O histórico de desfazer guarda as últimas 50 ações, incluindo as edições do agente.

## 6. Desfoque dados privados, faça anotações, adicione som {#6-blur-private-data-annotate-add-sound}

Pressione `A` para adicionar uma anotação e escolha o **Tipo** dela:

- **Desfoque**: Gaussiano ou Mosaico, retângulo ou oval. Coloque-o sobre e-mails, chaves de API ou nomes de clientes, estenda a região por todos os quadros em que eles aparecem e depois percorra o vídeo para conferir.
- **Texto**: com uma animação opcional (Esmaecer, Subir, Aparecer, Deslizar à Esquerda, Máquina de Escrever ou Pulsar).
- **Seta**: oito direções, largura do traço e cor ajustáveis.
- **Imagem**: um JPG, PNG, GIF ou WebP, como um logo.

Para o som, pressione `V` para gravar uma narração na linha do tempo, ou `M` para importar música (mp3, wav, m4a, aac, flac, ogg, opus). Cada faixa tem ganho, fades, repetição e silenciamento próprios.

A aba **Cursor** muda o estilo do ponteiro gravado no passo 2. Todas as ferramentas estão listadas em [Edição e linha do tempo](../editing-timeline.md).

## 7. Embuta as legendas {#7-burn-in-captions}

Na aba **Transcrição**, clique em **Legendas** e ative **Mostrar legendas**. Elas são desenhadas ao vivo a partir da transcrição, então os cortes do passo 5 valem para elas sem nenhuma etapa extra. Defina a fonte, o tamanho, o negrito, a cor, a caixa de fundo, a posição e de 1 a 12 palavras por linha. Confira o posicionamento na pré-visualização depois de qualquer mudança de formato.

O Whisper detecta o idioma falado, ou você pode forçar um dos 100 idiomas com **Regenerar em** na área Mídia. Para publicar em outro idioma, use **Traduzir** para um dos 15 idiomas de destino e selecione esse idioma em **Exibição** antes de exportar. A tradução passa pelo seu próprio provedor de LLM, então precisa de uma chave.

As legendas são embutidas no vídeo. O OpenScreen não grava nenhum arquivo `.srt` ou `.vtt`, então um player não consegue desativá-las. Detalhes: [Legendas e transcrição](../captions.md) e [como funciona o recurso de legendas](/features/captions/).

## 8. Exporte {#8-export}

**Escolha o formato.** O controle **Formato** na aba **Composição** oferece 16:9 (o padrão), 9:16, 1:1, 4:3, 4:5, 16:10, 10:16 ou a proporção original dos seus clipes.

**Exporte.** Clique em **Exportar** na barra superior:

- **MP4**: Baixa (720p), Média (1080p) ou Alta (resolução de origem); 24, 30 ou 60 fps; H.264 ou H.265. A caixa de diálogo marca o H.264 como a opção de **Melhor compatibilidade**. O bitrate do vídeo não é ajustável: cerca de 8 Mbit/s em 1080p.
- **GIF**: 15, 20, 25 ou 30 fps; tamanho Medium, Large ou Original; repetição ativada ou desativada. Os GIFs usam 256 cores, sem dithering, então servem para clipes curtos de interfaces com cores chapadas.

Não há marca d'água. Para exportar em outro formato, mude o formato e exporte de novo.

**Guarde o projeto.** Salve-o com `Ctrl/Cmd+S` como um arquivo `.openscreen`, para poder trocar um clipe e exportar de novo quando a interface mudar. Ele referencia sua mídia em vez de incorporá-la; `openscreen pack` reúne tudo em uma pasta portátil ([CLI](/docs/cli/)). Mais em [Exportação](../export.md).

## Publique o arquivo {#publish-the-file}

O OpenScreen não hospeda o seu vídeo, não cria links de compartilhamento nem conta visualizações. Envie o arquivo exportado para onde o seu público vai assistir.

## Quando o OpenScreen não é a ferramenta certa {#when-openscreen-is-not-the-right-tool}

- **Você quer um link hospedado com estatísticas de quem assistiu ou comentários.** Um gravador hospedado atende melhor. O Loom, por exemplo, compartilha cada gravação como um link em loom.com, e a página de preços dele lista informações sobre os espectadores e comentários em vídeo em todos os planos (em setembro de 2026). Veja [OpenScreen como alternativa ao Loom](/alternatives/loom/) para o caso mais restrito em que o OpenScreen serve.
- **Você quer uma demo interativa**, em que o espectador vai clicando. O OpenScreen exporta apenas vídeo e GIF.
- **Seu player de vídeo precisa de um arquivo de legenda separado.** O OpenScreen só embute as legendas.
- **Você grava em um celular ou tablet.** O OpenScreen é um app para desktop, para Windows, macOS 13 ou posterior e Linux.

## Fontes {#sources}

- OpenScreen: o [código-fonte na versão v1.11.0](https://github.com/getopenscreen/openscreen/tree/v1.11.0).
- Loom: [loom.com](https://www.loom.com) e [loom.com/pricing](https://www.loom.com/pricing), verificados em setembro de 2026.

Loom é uma marca de seu proprietário. O OpenScreen não tem vínculo com o Loom.
