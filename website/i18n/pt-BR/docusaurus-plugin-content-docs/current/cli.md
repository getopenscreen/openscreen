---
id: cli
title: CLI de gravação de tela para scripts e agentes
sidebar_label: CLI
description: "A CLI do gravador de tela OpenScreen grava, legenda e exporta projetos .openscreen a partir de scripts, jobs de CI e agentes de código, com saída NDJSON."
keywords:
  - gravador de tela por linha de comando
  - gravar tela pelo terminal
  - gravador de tela headless
  - automatizar vídeo de demonstração
  - NDJSON
  - openscreen export
---

# CLI de gravação de tela

A interface de linha de comando do OpenScreen vem embutida no próprio executável do app para desktop. `openscreen record`, `captions`, `export`, `pack`, `info` e `sources` rodam em um terminal sem abrir nenhuma janela, e `--json` transforma a saída deles em NDJSON no stdout. Um script, um job de CI ou um agente de código pode gravar uma tomada, editar o projeto `.openscreen` como JSON puro e renderizar um MP4 ou GIF com o mesmo compositor nativo do botão **Exportar** do editor.

Não é uma ferramenta de servidor. Todo comando inicia o Electron, que precisa de um servidor de exibição mesmo que nenhuma janela apareça, e a gravação precisa de uma sessão de desktop real. Veja [Quando a CLI não é a ferramenta certa](#when-the-cli-is-not-the-right-tool).

:::caution
A CLI e o formato de projeto `.openscreen` ainda podem mudar de forma incompatível entre versões. Confira seus scripts a cada atualização.
:::

## Como executar a CLI {#running-the-cli}

[Instale o OpenScreen](/download/) primeiro ([Instalação](./installation.md)). Todo comando é um subcomando do executável do app:

| Instalação | Executável |
|---|---|
| macOS | `/Applications/Openscreen.app/Contents/MacOS/Openscreen` |
| Instalador do Windows | `Openscreen.exe` na pasta escolhida na instalação: `%LOCALAPPDATA%\Programs\Openscreen\` para uma instalação para o usuário atual, `C:\Program Files\Openscreen\` para todos os usuários |
| `.deb`, `.rpm`, `.pacman` no Linux | `openscreen` |
| AppImage no Linux | `./Openscreen-Linux-1.11.0.AppImage` |
| Nix | `openscreen` |

Os exemplos desta página usam `openscreen`. No macOS e no Windows, use o caminho completo ou um alias:

```bash
/Applications/Openscreen.app/Contents/MacOS/Openscreen export demo.openscreen -o demo.mp4
```

- `openscreen help`, `--help` ou `-h` mostra o modo de uso.
- As opções (switches) do Chromium colocadas antes do subcomando são ignoradas. Se o sandbox do Chromium não conseguir iniciar na máquina, execute `./Openscreen-Linux-1.11.0.AppImage --no-sandbox export demo.openscreen`.
- As execuções da CLI não adquirem o bloqueio de instância única do app, então funcionam com o app para desktop aberto.
- A partir de um checkout do código-fonte, compile o app e seus auxiliares nativos como descrito em [Build and packaging (em inglês)](https://github.com/getopenscreen/openscreen/blob/main/technical-documentation/engineering/build-and-packaging.md) e depois execute `npm run cli -- <command> [options]`.

## Comandos {#commands}

### `openscreen record` {#openscreen-record}

Para gravar a tela pela linha de comando, execute `record`. Ele aciona o mesmo hook de gravação do app para desktop, e os arquivos vão para o diretório de gravações do app, junto das gravações feitas pela interface gráfica: o vídeo da tela e, quando há dados do ponteiro, um arquivo de telemetria do cursor `<video>.cursor.json`, que o cursor editável e o `--auto-zoom` leem.

```bash
openscreen record --duration 30 --project demo.openscreen --json
openscreen record --window "My App" --mic --system-audio
openscreen record --display 1 --cursor system
```

| Opção | Significado |
|---|---|
| `--display <n>` | Índice da tela, como listado por `openscreen sources` (padrão 0) |
| `--window <title>` | Grava a primeira janela cujo título contém `<title>`, sem diferenciar maiúsculas de minúsculas. Tem precedência sobre `--display` |
| `--mic` | Captura o microfone padrão |
| `--mic-device <name>` | Captura o microfone cujo nome contém `<name>`, sem diferenciar maiúsculas de minúsculas. Implica `--mic` |
| `--system-audio` | Captura o áudio do sistema |
| `--cursor <editable-overlay\|system>` | `editable-overlay` (padrão) oculta o ponteiro do sistema e o grava como dados, para que o editor possa mudar o estilo dele. `system` desenha o ponteiro no vídeo |
| `--duration <seconds>` | Para automaticamente depois desse tempo |
| `--project <out.openscreen>` | Ao terminar, grava um arquivo de projeto que referencia a gravação, pronto para `export` ou para o editor. Precisa terminar em `.openscreen` |
| `--json` | Eventos NDJSON no stdout |

Não há opção de webcam: uma gravação pela CLI contém só a tela e o áudio.

**Como parar.** Sem `--duration`, pare uma gravação com Ctrl+C (SIGINT), com SIGTERM ou digitando `stop`, `q` ou `quit` e Enter no stdin dela. Fechar o stdin não para a gravação. Um encerramento forçado pula a finalização normal, então não há evento `done` nem arquivo de projeto.

**Por plataforma**

- **macOS.** A captura passa pelo auxiliar do ScreenCaptureKit, sem alternativa. A permissão de Gravação de Tela é obrigatória; para um build de desenvolvimento iniciado a partir de um terminal, conceda-a ao terminal. Com `--mic`, a CLI pede acesso ao microfone se ele ainda não tiver sido concedido. Os cliques e os formatos do ponteiro só são gravados com a permissão de Acessibilidade.
- **Windows.** A captura passa pelo auxiliar do Windows Graphics Capture, a partir do Windows 10 build 19041. Em builds mais antigos, ou sem o auxiliar, o OpenScreen recorre à captura pelo navegador. O Windows nunca entrega SIGTERM: use Ctrl+C, `stop` no stdin ou `--duration`.
- **Linux.** A captura passa pelo auxiliar do PipeWire e pelo portal ScreenCast do desktop. O próprio seletor do portal decide o que é gravado, e ele abre a cada execução e espera uma resposta, então `--display` e `--window` não escolhem a fonte e uma gravação no Linux não pode começar sem intervenção humana. É preciso uma sessão de desktop com `xdg-desktop-portal`: uma sessão SSH sem tela não consegue gravar. Só um build sem o auxiliar recorre à captura do Chromium.

### `openscreen sources` {#openscreen-sources}

Lista as telas, as janelas e os microfones que o app enxerga, para que um script possa escolher valores de `--display`, `--window` e `--mic-device`. No Linux, o seletor do portal continua decidindo o que `record` captura.

```bash
openscreen sources                   # human-readable
openscreen sources --json            # NDJSON on stdout
openscreen sources -o sources.json   # payload written to a file
```

Com `--json`, o payload chega dentro do evento final `done`:

```json
{
  "event": "done",
  "success": true,
  "sources": {
    "displays": [{ "index": 0, "id": "screen:1:0", "name": "Entire screen" }],
    "windows": [{ "id": "window:210:0", "name": "My App" }],
    "microphones": [{ "label": "Built-in Microphone" }],
    "microphoneLabelsUnavailable": false
  }
}
```

`microphoneLabelsUnavailable` é `true` quando os nomes dos dispositivos dependem de uma permissão que não foi concedida, ou quando a lista de dispositivos não pôde ser lida em poucos segundos.

**Por que `-o` existe.** A CLI escreve no stdout apenas a própria saída; os diagnósticos do Chromium vão para o stderr. Já o wrapper em volta do processo é outra história. O `xvfb-run` do Ubuntu, a forma usual de rodar um binário gráfico em uma máquina sem tela, junta o stderr ao stdout, então os avisos de inicialização do Chromium chegam antes do JSON e `openscreen sources --json | jq` falha. `-o <file>` escreve em um lugar que nenhum wrapper consegue redirecionar, e evita diferenças de aspas e de codificação entre shells.

Os dois canais trazem formatos diferentes. O stdout envolve o payload no evento `done`, porque ele é um evento em um fluxo. O arquivo contém apenas o payload:

```bash
openscreen sources --json | jq 'select(.event == "done") | .sources.displays'   # stdout: inside the envelope
openscreen sources -o s.json && jq '.displays' s.json                             # file: the payload itself
```

O arquivo só é gravado em caso de sucesso, e de forma atômica: uma execução com falha deixa intacto um arquivo anterior. Verifique o código de saída, e não se o arquivo existe.

### `openscreen export` {#openscreen-export}

Renderiza um projeto em MP4 ou GIF com o compositor nativo que o editor usa na pré-visualização e na exportação. Zooms, recortes, regiões de velocidade, anotações e legendas, o cursor e o fundo vêm todos do projeto.

```bash
openscreen export demo.openscreen                          # format and quality from the project
openscreen export demo.openscreen -o out.mp4 --quality source
openscreen export demo.openscreen -o out.gif --gif-fps 20 --gif-size large
openscreen export demo.openscreen -o out.mp4 --auto-zoom --json
```

| Opção | Significado |
|---|---|
| `-o, --out <path>` | Arquivo de saída. A extensão, `.mp4` ou `.gif`, define o formato. Padrão: o caminho do projeto com `.mp4` ou `.gif` |
| `--format <mp4\|gif>` | Substitui o formato salvo no projeto. Precisa ser coerente com `--out` |
| `--quality <medium\|good\|source>` | Tamanho de saída: `medium` é 720p, `good` é 1080p, `source` segue o menor clipe depois do corte da imagem, então nunca amplia. Um GIF também parte desse tamanho |
| `--gif-fps <15\|20\|25\|30>` | Taxa de quadros do GIF |
| `--gif-size <medium\|large\|original>` | Limite de altura do GIF aplicado a esse tamanho: 720, 1080 ou nenhum |
| `--auto-zoom` | Antes de renderizar, adiciona zooms onde o ponteiro gravado parou, com o mesmo mecanismo dos [zooms automáticos do editor](/features/auto-zoom/). Os zooms existentes são mantidos, e os novos nunca se sobrepõem a eles |
| `--audio <file>` | Mixa um arquivo de narração (mp3, wav ou m4a) no MP4. Só MP4 |
| `--audio-mode <mix\|replace>` | `mix` (padrão) mantém o áudio da gravação por baixo da narração, com ganho de 40%; `replace` o descarta |
| `--audio-offset <seconds>` | Atraso antes de a narração começar (padrão 0) |
| `--json` | Progresso e resultado em NDJSON no stdout |

As exportações MP4 pela CLI são sempre **H.264 a 60 fps**. Não há opção de codec nem de taxa de quadros. A caixa de diálogo de [exportação](./export.md) do app para desktop também oferece H.265 e 24 ou 30 fps.

`--audio` atua depois da renderização: o fluxo de vídeo é copiado sem alteração, e uma nova faixa AAC é mixada e gravada sobre o mesmo arquivo de saída.

**Onde a mídia pode ficar.** Ao carregar um projeto, o app só aprova automaticamente a mídia referenciada que estiver no diretório de gravações dele ou na própria pasta do arquivo de projeto. Mantenha um projeto escrito à mão ao lado da mídia, ou grave com a CLI, que usa o diretório de gravações.

**Sem cancelamento.** Só o `record` atende a um pedido de parada. Encerrar o processo é a única forma de abandonar uma exportação; considere inutilizável o que ela tiver deixado no caminho de saída.

### `openscreen captions` {#openscreen-captions}

Transcreve o áudio do projeto no seu computador com o Whisper e depois grava anotações de legenda no arquivo de projeto. Nada é enviado, e o idioma é detectado automaticamente. A primeira execução baixa o modelo Whisper uma vez, cerca de 264 MB, como faz o app para desktop.

```bash
openscreen captions demo.openscreen --min-words 2 --max-words 7
openscreen export demo.openscreen -o demo.mp4   # captions are burned into the video
```

- `--min-words` e `--max-words` definem a quantidade de palavras por legenda. Padrões: 2 e 7.
- Rodar o comando de novo substitui as legendas que ele adicionou antes. As anotações que você mesmo adicionou são mantidas.
- O vídeo de tela do projeto precisa ter uma faixa de áudio, por exemplo de `record --mic`.
- As legendas são embutidas na exportação. Não há saída em arquivo de legenda. Veja [Legendas](./captions.md).

### `openscreen pack` {#openscreen-pack}

Copia um projeto e tudo o que ele referencia (vídeo da tela, vídeo da webcam, telemetria do cursor) para uma única pasta e reescreve os caminhos de mídia no projeto copiado.

```bash
openscreen pack demo.openscreen --out bundle/
```

`-o` é aceito como forma curta de `--out`, que é obrigatório. A pasta pode ser movida ou guardada como artefato de CI: quando os caminhos absolutos salvos não existem mais, o app recorre a arquivos com o mesmo nome ao lado do arquivo de projeto.

### `openscreen info` {#openscreen-info}

Mostra o que um projeto referencia e se o vídeo de tela dele ainda existe, além das configurações de exportação e de quantos zooms, recortes, regiões de velocidade e anotações ele contém.

```bash
openscreen info demo.openscreen --json
```

Ele termina com o código 1 quando o vídeo de tela referenciado está faltando.

## Saída legível por máquina {#machine-readable-output}

Com `--json`, o stdout traz um objeto JSON por linha. O stderr traz apenas diagnósticos, incluindo as linhas de log do próprio app.

```json
{"event":"started","command":"export"}
{"event":"progress","percentage":50,"currentFrame":60,"totalFrames":120,"estimatedTimeRemaining":3}
{"event":"done","success":true,"outputPath":"/path/out.mp4","format":"mp4","width":1920,"height":1080}
```

| Evento | Enviado quando | Campos |
|---|---|---|
| `started` | Uma execução de `record`, `sources`, `export` ou `captions` começa | `command` |
| `log` | Uma linha de status, como `Recording started` | `message` |
| `progress` | Quadros da exportação são codificados | `percentage`, `currentFrame`, `totalFrames`, `estimatedTimeRemaining` em segundos. Enquanto o `--audio` é mixado: `percentage` e `phase: "mixing-voiceover"` |
| `stopping` | `record` recebeu um pedido de parada | `reason`: `SIGINT`, `SIGTERM` ou `stdin` |
| `warning` | A execução deu certo, com uma ressalva | `message` |
| `error` | Uma falha foi informada | `message` |
| `done` | A execução terminou, com ou sem sucesso | `success`, depois o resultado, ou `error` |

O que `done` traz:

- **export:** `outputPath`, `format`, `width`, `height`.
- **record:** `screenVideoPath`, `cursorDataPath` (onde fica o arquivo de telemetria; ele pode não existir), `durationMs`; com `--project`, também `projectPath` e `projectData`, o projeto que ele gravou.
- **sources:** `sources`.
- **captions:** `projectPath`, `captionCount`.
- **pack:** `projectPath`, `files`, `cursorData`. `pack` não envia evento `started`.

`info --json` mostra um único objeto de resumo, sem campo `event`.

Um `pack` ou `info` que falha termina com um evento `error`, sem `done`. Um travamento pode terminar com um evento `error` ou sem mais nada no stdout. Confie no código de saída.

**Códigos de saída**

| Código | Significado |
|---|---|
| `0` | Sucesso |
| `1` | Falha, incluindo `info` em um projeto cujo vídeo de tela está faltando |
| `2` | Argumentos inválidos. A mensagem e o modo de uso vão para o stderr como texto puro, mesmo com `--json` |

## Exemplo: uma demo de produto automatizada {#example-an-automated-product-demo}

Um script ou um agente de código pode produzir uma demo com legendas e zooms sem abrir o editor:

```bash
# 1. Record 20 seconds of one window, with narration from the microphone
openscreen record --window "MyProduct" --mic --duration 20 --project demo.openscreen --json

# 2. Caption the narration on this machine
openscreen captions demo.openscreen --json

# 3. Add a manual zoom and a text label by editing the project JSON
node -e '
  const fs = require("fs");
  const p = JSON.parse(fs.readFileSync("demo.openscreen", "utf8"));
  p.editor.zoomRegions.push({ id: "z1", startMs: 2000, endMs: 6000, depth: 3,
    focus: { cx: 0.5, cy: 0.4 }, focusMode: "manual", source: "manual" });
  p.editor.annotationRegions.push({ id: "a1", startMs: 500, endMs: 4000,
    type: "text", content: "One-click setup", textContent: "One-click setup",
    position: { x: 8, y: 6 }, size: { width: 40, height: 12 },
    style: { fontSize: 24, color: "#fff" }, zIndex: 1 });
  fs.writeFileSync("demo.openscreen", JSON.stringify(p, null, 2));
'

# 4. Render, with automatic zooms added where the pointer paused
openscreen export demo.openscreen -o demo.mp4 --auto-zoom --json
```

No passo 3, `depth` vai de 1 a 6 (1.25× a 5×; 3 é 1.8×), e `cx` e `cy` posicionam o centro do zoom como frações do quadro.

Para narrar com um mecanismo de conversão de texto em fala, grave sem `--mic` e mixe a narração na exportação. Qualquer mecanismo que gere mp3, wav ou m4a funciona; o exemplo usa o `say` do macOS:

```bash
say -o voice.m4a --file-format=m4af "Welcome to MyProduct. Here is a quick tour."
openscreen export demo.openscreen -o demo.mp4 --auto-zoom --audio voice.m4a --audio-mode replace
```

`captions` lê a faixa de áudio da própria gravação, não uma narração mixada na exportação, então uma narração gerada por conversão de texto em fala não recebe legendas desse jeito.

**Exportar um vídeo feito em outra ferramenta.** `export` não precisa de uma gravação do OpenScreen. O menor projeto que ele aceita é um caminho de mídia e um editor vazio, que vira um único clipe com a duração inteira e as configurações padrão:

```json
{
  "version": 2,
  "media": { "screenVideoPath": "/path/to/clip.mp4" },
  "editor": {}
}
```

Salve-o na mesma pasta do clipe. Sem telemetria do cursor, `--auto-zoom` não tem com o que trabalhar.

## Telas, CI e servidores {#displays-ci-and-servers}

- Todo comando inicia o Electron, que inicia o Chromium, então é preciso um servidor de exibição mesmo que nenhuma janela abra. Em uma máquina Linux sem tela, um servidor X virtual iniciado com `xvfb-run` cumpre esse papel.
- `export` não captura nada, então funciona desse jeito, desde que haja um driver Vulkan: o compositor do Linux renderiza via Vulkan, e uma máquina sem GPU precisa de um driver por software, como o lavapipe do Mesa. O workflow de build Nix do projeto renderiza desse jeito um MP4 a partir de um clipe gerado, sob `xvfb-run` com lavapipe, em um runner Linux sem tela, e falha se nenhum MP4 for gerado.
- `record` não funciona assim. Nesse mesmo runner, o Chromium não encontra nenhuma tela para capturar, e no Linux o seletor do portal precisa de uma pessoa de qualquer forma.

## Quando a CLI não é a ferramenta certa {#when-the-cli-is-not-the-right-tool}

- **Você precisa gravar em um servidor** sem tela nem sessão de desktop. A gravação precisa de um desktop real, e no Linux alguém precisa responder ao seletor do portal a cada execução.
- **Você precisa de uma API estável e versionada.** A CLI e o formato de projeto ainda podem mudar entre versões.
- **Você precisa controlar codec, taxa de quadros ou bitrate pela linha de comando.** As exportações MP4 pela CLI são H.264 a 60 fps, e o bitrate do MP4 também não é ajustável no app.
- **Você precisa da webcam em uma gravação por script.** `record` não tem opção de câmera.
- **Você precisa de arquivos de legenda.** As legendas são apenas embutidas no vídeo.

Para ver os mesmos passos na prática, no editor, consulte [Como fazer um vídeo de demonstração de produto](./guides/product-demo-video.md). As respostas sobre licença e uso da rede estão nas [Perguntas frequentes](./faq.md).

## Código-fonte {#source-code}

A CLI faz parte do [repositório do OpenScreen](https://github.com/getopenscreen/openscreen):

- `electron/cli/args.ts`: o parser de argumentos e o texto de uso, com testes unitários em `args.test.ts`.
- `electron/cli/cliMain.ts`: a inicialização sem janela, o protocolo de stdio, os sinais de parada e os códigos de saída.
- `electron/cli/projectCommands.ts`: `pack` e `info`.
- `src/cli/`: os executores em janela oculta de `record`, `sources`, `export` e `captions`.
- `src/lib/cliContracts.ts`: os tipos de requisição e de resultado compartilhados pelos dois lados.
