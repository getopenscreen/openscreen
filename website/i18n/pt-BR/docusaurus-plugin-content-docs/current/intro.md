---
id: intro
title: "Documentação: instalar, gravar, editar e exportar"
sidebar_label: Introdução
sidebar_position: 1
description: "Documentação do OpenScreen 1.11.0, gravador de tela e editor com licença MIT: instale e depois grave, edite, legende e exporte no Windows, macOS e Linux."
keywords:
  - gravador de tela
  - gravador de tela de código aberto
  - gravador de tela grátis
  - editor de vídeo
  - documentação do OpenScreen
  - Windows
  - macOS
  - Linux
---

# Documentação do OpenScreen: instalar, gravar, editar, exportar

O OpenScreen é um **gravador de tela e editor gratuito e de código aberto**. Ele grava pela API de captura nativa de cada plataforma (ScreenCaptureKit no macOS, Windows Graphics Capture no Windows, PipeWire pelo portal ScreenCast no Linux) e faz na GPU a composição tanto da pré-visualização ao vivo quanto da exportação final, por meio de um renderizador nativo em Rust (Direct3D 11 no Windows, Metal no macOS, wgpu no Linux) — um único caminho, então o que você vê no editor é o que sai na exportação.

Estas páginas descrevem o **OpenScreen 1.11.0**, a versão estável de 9 de setembro de 2026. O que mudou em cada versão, e por quê, está no [diário de desenvolvimento (em inglês)](/blog/).

:::note
O OpenScreen lança versões com frequência. De uma versão para outra, o formato de projeto `.openscreen` e a [CLI](/docs/cli/) ainda podem mudar.
:::

## O que você pode fazer {#what-you-can-do}

- [Gravar](./recording.md) uma janela específica ou a tela inteira, com áudio do sistema, microfone e webcam — a partir de um HUD flutuante ou do próprio editor.
- Montar um projeto com várias fontes: [importar, recortar, cortar a imagem, reordenar e dividir clipes](./media-library.md) em uma única linha do tempo.
- [Editar](./editing-timeline.md) com zooms, recortes, velocidade por região, segmentos de Câmera em Tela Cheia, anotações de texto/imagem/seta/desfoque, temas de cursor, layouts de webcam e fundo/efeitos.
- Transcrever no seu computador com o Whisper e depois [embutir legendas](./captions.md) — com estilo ajustado ao vivo e traduzíveis para 15 idiomas pelo seu próprio provedor de LLM — ou cortar a gravação apagando palavras da transcrição.
- Conectar, se quiser, sua própria chave de LLM para [editar por chat](./ai-editing.md) — desativado por padrão, nunca obrigatório.
- [Exportar](./export.md) para MP4 (720p/1080p/resolução de origem, H.264 ou H.265) ou GIF animado.

As dúvidas sobre licença, marca d'água ou o que passa pela rede são respondidas nas [Perguntas frequentes](/docs/faq/). A comparação do OpenScreen com outros gravadores está nas páginas sobre o [Screen Studio](/alternatives/screen-studio/), o [Cap](/compare/openscreen-vs-cap/) e o [OBS Studio](/compare/openscreen-vs-obs/).

:::note
Gravação, edição, transcrição, legendas e exportação não exigem conta e continuam funcionando sem conexão com a rede. A transcrição precisa de um download antes: o modelo Whisper (~264 MB), baixado na primeira execução. Quando há conexão, o app também carrega do Google Fonts as fontes das anotações ao iniciar, e os builds instalados pelo GitHub Releases verificam atualizações no GitHub. A edição por chat com IA e a tradução de legendas só acessam a internet depois que você mesmo conecta um provedor, e apenas para se comunicar com ele.
:::

## Dados do projeto {#project-facts}

| | |
|---|---|
| **Licença** | MIT — gratuito para uso pessoal e comercial |
| **Versão documentada** | 1.11.0 ([todas as versões](https://github.com/getopenscreen/openscreen/releases)) |
| **Plataformas** | Windows 10 versão 1903 ou posterior (x64), macOS 13 ou posterior (Apple Silicon e Intel), Linux (pacotes x64; aarch64 pelo flake Nix) — veja a [Instalação](./installation.md) |
| **Origem** | Criado por Siddharth Vaddem, que [arquivou o repositório original](https://github.com/siddharthvaddem/openscreen) após a v1.5.0. O desenvolvimento continua aqui com a aprovação dele, com o mesmo nome e a mesma licença MIT. |

## Links oficiais {#official-links}

| | |
|---|---|
| **Site** | [getopenscreen.com](https://getopenscreen.com/) |
| **Código-fonte, versões, issues** | [github.com/getopenscreen/openscreen](https://github.com/getopenscreen/openscreen) |
| **Microsoft Store** | [apps.microsoft.com/detail/9MXQ1HQJL5G5](https://apps.microsoft.com/detail/9MXQ1HQJL5G5) |
| **Discord** | [getopenscreen.com/discord](https://getopenscreen.com/discord/) |

## Status deste site {#status-of-this-site}

Tudo o que está em **Recursos** na barra lateral documenta o que de fato já está no app hoje, não o roadmap. As especificações internas mais detalhadas das quais este site deriva — notas de arquitetura, documentação de engenharia, planos de teste — continuam no repositório e ainda não foram migradas para cá:

- [`README.md`](https://github.com/getopenscreen/openscreen/blob/main/README.md)
- [`CONTRIBUTING.md`](https://github.com/getopenscreen/openscreen/blob/main/CONTRIBUTING.md)
- [`AGENTS.md`](https://github.com/getopenscreen/openscreen/blob/main/AGENTS.md)
- [`docs/`](https://github.com/getopenscreen/openscreen/tree/main/docs)
