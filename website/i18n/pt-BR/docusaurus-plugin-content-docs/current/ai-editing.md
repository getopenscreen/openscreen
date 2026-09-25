---
id: ai-editing
title: Edição com IA
sidebar_position: 8
description: "Conecte sua própria chave de LLM para editar projetos do OpenScreen por chat. Opcional e desativado por padrão: nada é enviado a um modelo antes disso."
keywords:
  - edição de vídeo com IA
  - editor de vídeo com LLM
  - editar vídeo por chat
  - use sua própria chave de API
  - privacidade
---

# Edição com IA

O OpenScreen traz um agente opcional que edita o seu projeto a partir de um painel de chat. Ele fica **desativado até você mesmo conectar um provedor**, e nada é enviado a nenhum modelo antes disso. Depois de conectado, o agente conversa apenas com esse provedor, e o mesmo vale para a [tradução de legendas](./captions.md#translation). Os outros usos de rede do app (o download do modelo Whisper, as fontes das anotações, a verificação de atualizações) estão listados na [introdução](./intro.md).

:::tip
Nada disso é obrigatório. Gravação, edição, transcrição, legendas e exportação funcionam sem conta e sem provedor, quer você abra o painel de chat, quer não. Dessas, só a transcrição precisa de um download, uma única vez: o [modelo Whisper](./captions.md#transcribing), na primeira execução.
:::

## Como conectar um provedor {#connecting-a-provider}

Abra a coluna de chat (o botão no canto esquerdo da barra superior, no modo **Editar**) e depois **Configurações de IA** → escolha um provedor e cole uma chave de API:

| Provedor | Observações |
|---|---|
| **Claude API** (Anthropic) | |
| **OpenAI API** | |
| **Gemini API** (Google) | |
| **Mistral API** | |
| **OpenRouter API** | Uma chave, vários modelos. |
| **Requesty API** | Uma chave, vários modelos. |
| **MiniMax API** / **MiniMax Token Plan** | |
| **OpenAI Compatible** | Qualquer endpoint no formato da OpenAI — você informa a URL base. |

Sua chave é armazenada criptografada pela proteção de credenciais do seu sistema operacional (`safeStorage` do Electron); se a criptografia não estiver disponível, o salvamento falha em vez de recorrer a texto puro. Os servidores do OpenScreen nunca a veem, porque eles não existem — as requisições vão direto do seu computador para o provedor que você escolheu. Variáveis de ambiente específicas de cada provedor também funcionam, se você preferir não armazenar nenhuma chave.

:::note
As opções de login do ChatGPT e do GitHub Copilot foram **removidas na 1.8.0**. Elas funcionavam distribuindo credenciais de cliente próprias dessas empresas, que não cabe a nós redistribuir. Em vez disso, use um provedor com chave de API.
:::

## Como usar o agente {#using-the-agent}

Descreva a edição em linguagem natural — "corte o tempo morto da introdução", "dê zoom quando eu abrir o terminal". O agente trabalha com operações reais da linha do tempo, que podem ser desfeitas, e não com uma nova renderização: ele pode adicionar e ajustar recortes, zooms, regiões de velocidade, anotações e segmentos de Câmera em Tela Cheia, editar os pontos de entrada/saída dos clipes, reordenar ou remover clipes e ler a transcrição para encontrar o trecho a que você se refere.

O painel em volta dele:

- **Conversas** — histórico, renomear, excluir e começar uma nova. Cada uma mantém o próprio estado do agente.
- **Seletor de modelo** — lista ao vivo dos modelos do provedor conectado, com um controle de esforço de raciocínio quando o provedor oferece um.
- **Medidor de contexto** — estimativa dos tokens usados em relação ao limite, com a ação **Compactar contexto**, que resume os turnos anteriores em vez de descartá-los.
- **Rebobinar até esta mensagem** — desfaz as edições do agente e todos os turnos seguintes a partir desse ponto, restaurando juntos o projeto, a conversa e o estado do agente.
- **Edições do projeto** — um interruptor em **Configurações de IA**. Quando ele está desativado, toda edição que o agente tenta é recusada: o agente ainda pode ler o projeto e descrever a alteração que faria, e não aplica nada até você reativar o interruptor.

`Ctrl/Cmd + Z` desfaz uma edição do agente exatamente como uma edição manual.

A opção **Cortes inteligentes** (marcada *Com IA*) no menu de melhoria automática da linha do tempo é o mesmo agente com um prompt único. (A outra opção, **Zooms automáticos**, lê o movimento gravado do cursor e não precisa de nenhum provedor.)

## O que mais usa o seu provedor {#what-else-uses-your-provider}

A [tradução de legendas](./captions.md#translation) é uma única chamada de transformação de texto ao mesmo modelo — ela não roda o loop do agente e não pode mexer no seu documento. A transcrição e a renderização das legendas continuam inteiramente no seu computador em qualquer caso.
