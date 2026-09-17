---
id: captions
title: Legendas e transcrição
sidebar_position: 7
description: "Transcreva localmente com o Whisper em 100 idiomas, embuta legendas com estilo, traduza com sua própria chave de LLM e corte a gravação apagando palavras."
keywords:
  - legendas automáticas
  - legendar vídeo
  - transcrição com Whisper
  - transcrição offline
  - tradução de legendas
  - editar vídeo pela transcrição
---

# Legendas e transcrição

O OpenScreen transcreve o áudio da sua gravação **inteiramente no seu computador** — seu áudio nunca é enviado, e, depois que o modelo está no disco, a transcrição funciona offline. Essa mesma transcrição é a fonte de duas coisas: as legendas embutidas no vídeo e uma visualização em texto a partir da qual você pode editar a gravação.

## Transcrição {#transcribing}

Cada clipe tem a própria transcrição. Você pode gerá-la de duas formas:

- Na área **Mídia** — selecione o cartão de um arquivo e clique em **Regenerar**. É também ali que você força um dos 100 idiomas do Whisper em **Regenerar em**, em vez de deixar a detecção em **Automático**, e onde fica o status de cada arquivo (Transcrição pendente, Transcrevendo, Transcrição pronta, Falha na transcrição e os outros listados em [Biblioteca de mídia](./media-library.md#media-mode)).
- Na aba **Transcrição** do inspetor do editor — **Transcrever agora** roda o mesmo processo na mídia atual.

O motor whisper.cpp vem dentro do app; o modelo, não. A primeira execução o baixa de huggingface.co (~264 MB, verificado por SHA-256 e gravado de forma atômica, para que um download pela metade nunca seja usado) — o único momento em que a transcrição precisa de rede. Depois disso, ela é totalmente offline, em um backend escolhido em tempo de execução: Metal no Apple Silicon, Vulkan no Windows e no Linux com alternativa em CPU, e CPU nos Macs Intel.

Os tempos de cada palavra vêm dos timestamps de tokens por DTW do próprio Whisper e depois são reancorados no áudio em si — cada limite é puxado de volta para o momento mais silencioso logo antes dele. É isso que faz um corte feito pela transcrição cair onde a palavra realmente começa, e não uma sílaba depois.

## Legendas {#captions}

As legendas são uma **visualização ao vivo da transcrição**, não um texto gerado que você precisa manter depois. Altere a transcrição, as configurações das legendas ou mova clipes na linha do tempo, e os blocos de legenda acompanham já no quadro seguinte — não há etapa de regeneração nem cópia desatualizada para conciliar.

Na aba **Transcrição** do inspetor, clique em **Legendas**:

| Seção | Controles |
|---|---|
| **Mostrar legendas** | Liga/desliga geral, para a pré-visualização e para a exportação. |
| **Idioma** | *Original (transcrição)* ou qualquer camada de tradução que você tenha gerado. |
| **Texto** | Fonte, tamanho, negrito, cor do texto. |
| **Fundo** | Liga/desliga, cor e opacidade da caixa atrás do texto. |
| **Posição** | **Base** ou **Topo**, com a distância até essa borda (0–50% do quadro); **Esquerda**, **Centro** ou **Direita**, com a distância até esse lado (0–25%, nenhuma para Centro). |
| **Comprimento da linha** | Mínimo e máximo de palavras por linha (1–12). As linhas são montadas dentro desse intervalo. |

Tudo em **Posição** é medido em relação ao **quadro exportado**, não ao vídeo dentro dele. Quando você muda o espaçamento, as legendas continuam onde você as colocou, e podem ficar na área de espaçamento — defina a distância vertical como 0 e o texto encosta na borda superior ou inferior do quadro. As legendas longas crescem para longe da borda em que estão fixadas: uma legenda na base cresce para cima, e uma no topo cresce para baixo.

O tamanho é expresso em pixels em um quadro de 1080 de altura e é ajustado à escala da saída real, então as legendas ficam iguais em 720p, 1080p ou na resolução de origem. A pré-visualização e a exportação usam o mesmo código de layout — o que você vê é o que fica embutido. Elas só existem na forma embutida: o OpenScreen não grava nenhum arquivo `.srt` ou `.vtt` à parte, então quem assiste ao arquivo não consegue desativar as legendas. O [comparativo de legendas locais](/features/captions/) cita gravadores que geram um arquivo de legenda.

### Tradução {#translation}

Escolha um idioma de destino e clique em **Traduzir**. A lista traz quinze idiomas de destino: inglês, francês, espanhol, alemão, italiano, português, holandês, polonês, turco, russo, árabe, hindi, japonês, coreano e chinês.

A tradução passa pelo provedor de LLM que você conectou (veja [Edição com IA](./ai-editing.md)) — é o único recurso de legendas que precisa de rede. Ela é armazenada **ao lado** da transcrição, nunca dentro dela: o texto original e os tempos continuam intactos, você pode voltar para *Original* a qualquer momento, e excluir uma tradução deixa a gravação exatamente como estava. Traduzir de novo depois de adicionar material só custa o material novo, e qualquer trecho que o modelo não devolva volta às palavras originais, em vez de ser inventado.

:::note
Projetos feitos com o antigo fluxo "Gerar legendas" guardam o texto das legendas como anotações de verdade, que seriam desenhadas por cima da camada ao vivo. O painel de legendas as detecta e se oferece para removê-las — ele pergunta antes, já que isso apaga dados.
:::

## Edição da transcrição {#transcript-editing}

A aba **Transcrição** mostra a transcrição agregada de todos os clipes da linha do tempo. É uma visualização em texto, ao vivo, da sua gravação:

- Selecione uma palavra ou várias palavras seguidas e pressione `Backspace`/`Delete` para marcar esse trecho como pulado — ele é cortado da reprodução e da exportação, exatamente como uma região de recorte na linha do tempo, só que controlado pelo texto.
- Os trechos pulados aparecem riscados em vermelho. Passe o mouse sobre um deles para restaurá-lo.
- Os silêncios aparecem marcados no texto e podem ser cortados ou restaurados do mesmo jeito.

Nenhum upload, nenhuma nuvem — isso funciona sobre a transcrição que já está no seu projeto.
