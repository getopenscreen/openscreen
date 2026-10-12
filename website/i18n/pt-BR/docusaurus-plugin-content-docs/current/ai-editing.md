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

A opção **Cortes inteligentes** (marcada *Com IA*) no menu de melhoria automática da linha do tempo é o mesmo agente com um prompt único. (A outra opção, **Zooms automáticos**, lê os cliques gravados e não precisa de nenhum provedor.)

## O que mais usa o seu provedor {#what-else-uses-your-provider}

A [tradução de legendas](./captions.md#translation) é uma única chamada de transformação de texto ao mesmo modelo — ela não roda o loop do agente e não pode mexer no seu documento. A transcrição e a renderização das legendas continuam inteiramente no seu computador em qualquer caso.

## Como usar o Claude Code, o Codex ou outro cliente MCP {#using-claude-code-codex-or-another-mcp-client}

Se você já usa um agente de código com IA, como o Claude Code ou o Codex, ele pode conduzir as mesmas ferramentas de edição, conectado com a própria conta. Nada dessa conta passa pelo OpenScreen.

1. **Configurações de IA** → **Servidor MCP** → ative-o. Ele só escuta no seu próprio computador (`127.0.0.1`), na porta exibida.
2. Copie o comando do **Claude Code** ou do **Codex** exibido ali e execute-o em um terminal. O comando do Claude Code leva o token de acesso. Já o Codex o lê da variável de ambiente `OPENSCREEN_MCP_TOKEN`: defina-a no shell a partir do qual você inicia o Codex.
3. Mantenha um projeto aberto no editor do OpenScreen e depois peça a edição ao seu agente.

As ferramentas são as que o agente integrado usa, e elas agem sobre o projeto aberto no editor. Os clientes MCP só podem **ler** o projeto até você também ativar **Edições do projeto** na seção Servidor MCP; esse interruptor é separado do interruptor do agente integrado e começa desativado. Depois de ativado, cada edição é salva assim que é aplicada e se desfaz com `Ctrl/Cmd + Z`. Os clientes são instruídos a salvar um ponto de restauração antes de uma série de edições, então você pode pedir a eles que deixem o projeto como estava em um único passo, que o próprio `Ctrl/Cmd + Z` pode desfazer. **Gerar novo** token desconecta todos os clientes configurados com o antigo.

## Como deixar um agente fazer o vídeo inteiro {#letting-an-agent-make-the-whole-video}

O servidor acima edita projetos. Para que um agente faça um vídeo inteiro sozinho, da gravação à exportação, adicione, em vez disso, o OpenScreen ao agente como servidor stdio: o agente inicia o próprio executável do app com `mcp`. Ele recebe as mesmas ferramentas de edição, mais `listSources`, `startRecording`, `stopRecording`, `setPointerTrack`, `exportVideo` e `getFrames`.

O jeito mais rápido é colar isto no Claude Code:

```text
Install the OpenScreen demo skill with `npx skills add getopenscreen/openscreen --skill openscreen-demo -a claude-code`, then follow it to make a demo video of this feature.
```

A skill instala o OpenScreen se ele estiver faltando, depois que você concordar, e adiciona o servidor MCP dele. Em seguida, ela pede que você abra uma nova sessão e diga *continue the OpenScreen demo*: um agente só recebe ferramentas novas em uma nova sessão. Para configurar à mão, em vez disso:

```bash
claude mcp add openscreen -- "/Applications/Openscreen.app/Contents/MacOS/Openscreen" mcp
codex mcp add openscreen -- "/Applications/Openscreen.app/Contents/MacOS/Openscreen" mcp
```

O executável de cada sistema está listado em [Como executar a CLI](./cli.md#running-the-cli).

- **Sem porta, sem token, sem configuração.** O agente inicia o processo por conta própria, com as suas permissões, como faria ao rodar `openscreen record`. Por isso ele pode gravar a sua tela e editar sem o interruptor **Edições do projeto**.
- **Cada tomada vira um novo projeto** na sua lista de projetos, com um zoom em cada clique gravado, como uma gravação feita no app. Não o edite no editor enquanto o agente ainda estiver trabalhando nele: o editor mantém a própria cópia.
- **Uma tomada conduzida por um script** (o Playwright, por exemplo) nunca move o ponteiro da tela. O agente passa ao OpenScreen o próprio registro das ações com `setPointerTrack`, e o vídeo ganha um cursor e seus zooms do mesmo jeito.
- **A skill `openscreen-demo`** ensina a um agente o trabalho inteiro, do storyboard até o vídeo pronto. Depois ele anexa o vídeo a um pull request, para que os revisores vejam a mudança ali mesmo, ou redige um post no X que só publica depois que você disser sim. Adicione-a com `npx skills add getopenscreen/openscreen --skill openscreen-demo`. A receita é [`skills/openscreen-demo/SKILL.md`](https://github.com/getopenscreen/openscreen/blob/main/skills/openscreen-demo/SKILL.md).
