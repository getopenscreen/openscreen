---
id: effects
title: Efeitos personalizados
description: "Peça a um agente de IA um efeito visual que as configurações não oferecem. Ele escreve um shader de GPU que o OpenScreen desenha na pré-visualização e em cada exportação."
keywords:
  - efeitos de vídeo personalizados
  - efeitos shader
  - WGSL
  - efeitos de vídeo com IA
  - efeitos GPU
---

# Efeitos personalizados

Quando as configurações não têm o visual que você procura, peça a um agente: uma onda a cada clique, uma vinheta que respira, um fade para preto nos últimos segundos. O agente escreve o efeito como um pequeno shader de GPU, e o OpenScreen o desenha na pré-visualização e em cada exportação, MP4 e GIF, no Windows, no macOS e no Linux.

Os efeitos vêm de um agente: o chat integrado ou um cliente MCP como o Claude Code ou o Codex (veja [Edição com IA](./ai-editing.md)). Depois que o efeito está no projeto, você mesmo o ajusta no editor.

## Pedir um efeito {#asking-for-an-effect}

Descreva o que você quer ver, e quando: "uma onda a cada clique", "fade para preto nos dois últimos segundos, com as legendas". O agente escreve o efeito, coloca-o na linha do tempo e pode ver o resultado com `getFrames` sem exportar o vídeo.

Um efeito sabe onde está o cursor e onde caiu cada clique, onde ficam a gravação e a webcam no vídeo depois dos zooms e do layout, e em que momento está. Assim, um halo pode seguir o mouse, e uma onda pode partir de cada clique, onde quer que o zoom o tenha levado.

## No editor {#in-the-editor}

Os efeitos ganham uma fileira própria na linha do tempo, abaixo dos trechos de Câmera em Tela Cheia, assim que o projeto tem um. Cada bloco leva o nome do efeito. Mova, redimensione, copie e cole ou exclua o bloco como qualquer outra região, e `Ctrl/Cmd + Z` desfaz a alteração. Só um efeito toca por vez: colar sobre outro efeito é recusado.

Clique em um bloco para abrir o inspetor dele:

- **Um controle para cada ajuste** que o agente deu ao efeito: um controle deslizante, um interruptor, uma cor ou um ponto.
- **Aplica-se a**, onde o efeito é desenhado:
  - **Imagem**, o padrão: a gravação, a webcam, o cursor e o fundo, abaixo das suas anotações e legendas, que continuam legíveis.
  - **Textos**: só as anotações e as legendas.
  - **Ambos**: o quadro inteiro, com o texto, para um fade para preto que também cubra as legendas.
- **Custo**: **Leve**, **Médio**, **Pesado** ou **Muito pesado** (veja [abaixo](#cost)).
- **Código**: o shader, somente leitura, com **Copiar código**. Para mudá-lo, peça ao agente.

Um efeito copiado e colado em outro projeto leva o seu código junto.

## Custo {#cost}

O custo é estimado a partir do código, contando quantas vezes o efeito lê a imagem para cada pixel. O mesmo código recebe o mesmo nível em todos os computadores. Nada é recusado pelo custo: quanto mais pesado o efeito, mais curto o trecho que combina com ele.

| Nível | Efeitos típicos | Combina com |
|---|---|---|
| **Leve** | vinheta, correção de cor, onda ao clicar | o vídeo inteiro |
| **Médio** | aberração cromática, desfoque pequeno, glitch | algumas dezenas de segundos |
| **Pesado** | desfoque forte, bokeh | uma transição, um momento de destaque |
| **Muito pesado** | raymarching, simulações | alguns segundos: a exportação continua exata, mas mais lenta, e a pré-visualização pode ficar lenta em uma GPU pequena |

## Se um efeito não compila {#if-an-effect-doesnt-compile}

O código de um agente é compilado antes de o efeito ser aceito. Um código que falha é recusado com o erro do compilador, e o projeto não muda.

Um projeto aberto em outro computador ainda pode encontrar um compilador que discorda. O efeito então não é desenhado, o inspetor dele mostra **Não compila neste computador** com o erro, e a exportação continua sem ele.

## Projetos de outras pessoas {#projects-from-someone-else}

Um projeto leva o código dos seus efeitos, então abrir o projeto de outra pessoa executa código que você não escreveu. Esse código roda só na GPU, sem acesso aos seus arquivos, à rede nem à memória do app.

## Para autores de agentes {#for-agent-authors}

As ferramentas são `addEffect`, `setEffect`, `setEffectDefinition` e `getEffect`, e `removeModifier` remove um efeito. O contrato completo, ou seja, a função `effect(uv)`, o que ela pode ler e as suas regras, é o recurso MCP `openscreen://effects/contract`.
