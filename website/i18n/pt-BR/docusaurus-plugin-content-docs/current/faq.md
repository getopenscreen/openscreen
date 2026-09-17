---
id: faq
title: "FAQ do OpenScreen: licença, privacidade e links"
sidebar_label: Perguntas frequentes
description: "O OpenScreen é grátis para uso comercial? Sim, pela licença MIT. E mais: marca d'água, uso offline, privacidade, instaladores assinados e links oficiais."
keywords:
  - OpenScreen perguntas frequentes
  - grátis para uso comercial
  - licença MIT
  - sem marca d'água
  - gravador de tela offline
  - projeto original do OpenScreen
---

# Perguntas frequentes sobre o OpenScreen

O OpenScreen é um gravador de tela e editor de vídeo gratuito, com licença MIT, para Windows, macOS e Linux. Ele é gratuito para uso comercial, sem conta e sem marca d'água. Esta página responde às perguntas que as pessoas fazem antes de instalá-lo: licença, o que passa pela rede, como os instaladores são assinados e quais sites são oficiais. Ele não é o mesmo produto que o Open Screen, de openscreen.io.

## O OpenScreen é gratuito para uso comercial? {#is-openscreen-free-for-commercial-use}

**Sim.** O OpenScreen é distribuído sob a [licença MIT](https://github.com/getopenscreen/openscreen/blob/main/LICENSE).

- Você pode usá-lo, copiá-lo, modificá-lo, distribuí-lo e vendê-lo. A única condição é manter o aviso de copyright e de permissão junto com as cópias do software.
- O texto da licença trata do software. Ele não diz nada sobre os vídeos que você faz com ele.
- Não há conta, plano pago nem recurso premium.

## O OpenScreen adiciona marca d'água? {#does-openscreen-add-a-watermark}

**Não.** As exportações em MP4 e GIF não têm marca d'água, e não existe versão paga para removê-la. Os formatos estão em [Exportação](./export.md).

## O OpenScreen funciona offline? {#does-openscreen-work-offline}

**Gravação, transcrição e renderização rodam no seu computador.** O OpenScreen não tem nenhum recurso de upload, então suas gravações ficam no seu disco. Mesmo assim, o app faz algumas conexões de rede, então dizer "totalmente offline" seria errado:

- **Google Fonts, a cada inicialização.** O app carrega dos servidores do Google as fontes das anotações de texto, incluindo fonts.googleapis.com.
- **huggingface.co, uma vez.** A primeira transcrição baixa o modelo Whisper, de cerca de 264 MB, e o confere com um hash SHA-256. Depois disso, a transcrição não precisa de conexão.
- **github.com e api.github.com.** Os builds que se atualizam sozinhos procuram uma nova versão a cada 24 horas e quando você pede. Por padrão, eles só avisam que há uma disponível.
- **Seu provedor de IA, somente se você conectar um.** A edição por chat envia suas mensagens e os dados do projeto que ela lê, como a linha do tempo e a transcrição. A tradução de legendas envia o texto das legendas. As duas ficam desativadas até você conectar um provedor. Veja [Edição com IA](./ai-editing.md).

## O OpenScreen coleta dados de uso ou relatórios de falha? {#does-openscreen-collect-analytics-or-crash-reports}

**Não.** O código do app não contém nenhum SDK de analytics nem de relatório de falhas.

- Não existe servidor do OpenScreen para o qual o app envie relatórios.
- As chaves de provedores de IA são armazenadas criptografadas com o `safeStorage` do Electron. Se a criptografia não estiver disponível, a chave não é salva.

## É seguro instalar o OpenScreen? {#is-openscreen-safe-to-install}

**O código-fonte é público, e as versões para macOS e da Store são assinadas.** Baixe somente pelos links em [Links oficiais](#what-are-the-official-openscreen-links).

- **macOS:** os builds a partir da 1.9.0 são assinados com um Apple Developer ID e notarizados.
- **Windows, Microsoft Store:** a Microsoft assina o pacote, então ele é instalado sem aviso.
- **Windows, instalador `.exe`:** sem assinatura de código. O SmartScreen mostra "O Windows protegeu o computador". Escolha **Mais informações** e depois **Executar assim mesmo**, ou use a versão da Store.

A [Instalação](./installation.md) traz os passos para cada plataforma.

## Em quais sistemas o OpenScreen roda? {#which-systems-does-openscreen-run-on}

| Sistema | Mínimo | Pacotes |
|---|---|---|
| macOS | 13 Ventura | `.dmg` para Apple Silicon e para Intel |
| Windows | 10 versão 1903, x64 | Microsoft Store, instalador `.exe` |
| Linux | x64, PipeWire e xdg-desktop-portal | AppImage, `.deb`, `.rpm`, `.pacman`, flake Nix |

- No Windows, a captura nativa exige o build 19041 (Windows 10 versão 2004). Builds mais antigos recorrem à captura pelo navegador.
- Conte com 8 GB de RAM; o recomendado é 16 GB.

## Existe versão ARM64 para Windows ou Linux? {#is-there-an-arm64-build-for-windows-or-linux}

**Não há pacote pronto.** As versões para Windows e Linux são somente x64.

- No Linux ARM64, o flake Nix compila o OpenScreen a partir do código-fonte para `aarch64-linux`.
- Os Macs com Apple Silicon têm um `.dmg` nativo.

## Posso instalar o OpenScreen com winget, Homebrew ou Flathub? {#can-i-install-openscreen-with-winget-homebrew-or-flathub}

- **winget:** sim, pela fonte da Store: `winget install --source msstore OpenScreen`.
- **Homebrew:** não há cask oficial. Em setembro de 2026, o tap `siddharthvaddem/openscreen` do projeto original ainda está fixado na versão 1.5.0. Em vez disso, use o `.dmg` da [página de download](/download/).
- **Flathub:** o OpenScreen não está listado.

## Este é o projeto OpenScreen original? {#is-this-the-original-openscreen-project}

**É a continuação dele.**

- Siddharth Vaddem criou o OpenScreen e arquivou o [repositório original](https://github.com/siddharthvaddem/openscreen) após a v1.5.0.
- O desenvolvimento passou para [getopenscreen/openscreen](https://github.com/getopenscreen/openscreen) com a aprovação dele, com o mesmo nome e a mesma licença MIT.
- O README arquivado chama este projeto de spin-off conduzido pela comunidade e liderado por um dos principais colaboradores. Esse colaborador é Etienne Lescot, que mantém o projeto. O link do README, github.com/EtienneLescot/openscreen, redireciona para o repositório atual.
- O repositório arquivado não recebe atualizações. [Picking up OpenScreen (em inglês)](/blog/2026/06/15/picking-up-openscreen/) explica a transição.

## O OpenScreen tem relação com openscreen.io ou openscreen.net? {#is-openscreen-related-to-openscreenio-or-openscreennet}

- **openscreen.io:** não. É outro produto, o Open Screen, que o próprio site apresenta como um gravador de tela para macOS. O OpenScreen não tem vínculo com ele.
- **openscreen.net:** não é um site oficial do OpenScreen.

## Quais são os links oficiais do OpenScreen? {#what-are-the-official-openscreen-links}

| O quê | Link |
|---|---|
| Site | [getopenscreen.com](https://getopenscreen.com/) |
| Código-fonte, versões e issues | [github.com/getopenscreen/openscreen](https://github.com/getopenscreen/openscreen) |
| Microsoft Store | [apps.microsoft.com/detail/9MXQ1HQJL5G5](https://apps.microsoft.com/detail/9MXQ1HQJL5G5) |
| Discord | [getopenscreen.com/discord](https://getopenscreen.com/discord/) |
| Projeto original, arquivado e somente leitura | [github.com/siddharthvaddem/openscreen](https://github.com/siddharthvaddem/openscreen) |

## O que acontece se uma gravação for interrompida? {#what-happens-if-a-recording-is-interrupted}

No Windows e no macOS, os gravadores nativos escrevem MP4 fragmentado, em fragmentos de um segundo. Se uma gravação for interrompida, o arquivo ainda pode ser reproduzido até o último fragmento completo.

Os relatos de bugs e os pedidos de recursos vão para as [issues do GitHub](https://github.com/getopenscreen/openscreen/issues).

## O que o OpenScreen não faz? {#what-doesnt-openscreen-do}

Se você precisa de algum destes itens, o OpenScreen não é a ferramenta certa:

- **Compartilhamento hospedado.** Sem links de compartilhamento, armazenamento em nuvem, espaços de equipe ou comentários. Seus arquivos ficam no seu disco. Veja [OpenScreen como alternativa ao Loom](/alternatives/loom/).
- **Transmissão ao vivo.** Veja [OpenScreen vs OBS Studio](/compare/openscreen-vs-obs/).
- **Arquivos de legenda.** As legendas são embutidas no vídeo. Não há exportação em SRT ou VTT. Veja [Legendas](./captions.md).
- **Celular.** Não há app para celular nem captura no iOS ou no Android.

## Como começar? {#how-do-i-get-started}

1. Baixe o instalador para o seu sistema na [página de download](/download/).
2. Siga a [Instalação](./installation.md) para a sua plataforma.
3. Grave, recorte e exporte um primeiro vídeo com o [Início rápido](./quick-start.md).

## Fontes {#sources}

Verificadas em setembro de 2026:

- Repositório original e seu aviso de arquivamento: [github.com/siddharthvaddem/openscreen](https://github.com/siddharthvaddem/openscreen)
- Tap do Homebrew do projeto original: [github.com/siddharthvaddem/homebrew-openscreen](https://github.com/siddharthvaddem/homebrew-openscreen)
- Open Screen: [openscreen.io](https://openscreen.io/)

Open Screen, Loom, OBS Studio e os demais nomes de produtos nesta página são marcas de seus respectivos proprietários. O OpenScreen não tem vínculo com o Open Screen (openscreen.io), o Loom nem o OBS Studio.
