# 🪐 Órbita

Chat, voz, vídeo e lives **peer-to-peer**, direto no navegador. Quem abre a sala vira o **host** — o centro da órbita — e os amigos orbitam em volta.

**▶ Abrir o app: https://zelguilherme.github.io/orbita/**

![Órbita](public/og.png)

## O que tem

- **Salas no estilo Discord**: canais de texto e de voz, criadas por quem abre a sala (o host).
- **Convite por link ou código**, sem cadastro e sem conta. Você escolhe um nome e a cor do seu planeta.
- **Chat**: markdown (`**negrito**`, `*itálico*`, `` `código` ``, `||spoiler||`), menções com `@`, reações, edição, imagens (colar, arrastar ou anexar), "fulano está digitando" e contador de não lidas.
- **Voz**: detecção de fala, mutar e ensurdecer, volume por pessoa, cancelamento de eco e supressão de ruído.
- **Câmera** na chamada.
- **Lives**: compartilhamento de tela com áudio até 1080p a 60 fps, contador de espectadores, picture-in-picture e tela cheia.
- **Visão "Órbita" da chamada**: o host fica no centro com um anel dourado e os membros giram em volta, com um anel verde em quem está falando.
- **Poderes do host**: silenciar para todos, remover, banir, trancar a sala, criar, renomear e apagar canais, passar a coroa.
- **Migração automática de host**: se o host cair, o membro mais antigo assume e a sala continua, sem derrubar a voz.
- **Instalável** como app (PWA).

## Como funciona

```
                 servidor de sinalização (só para as pessoas se acharem)
                                  0.peerjs.com
                                       ┊
     Bruno ◀━━━━━━━━━━━━━━━━━  👑 Ana · host (hub)  ━━━━━━━━━━━━━━━━━▶ Carla
        ▲          dados: chat, membros, canais, permissões             ▲
        ┗━━━━━━━━━━━━━━━━━━━━ voz · câmera · lives ━━━━━━━━━━━━━━━━━━━━━┛
                               (malha P2P direta)
```

- **O hub roda no host.** O navegador de quem cria a sala reserva o ID `orbita-v1-sala-<código>` no servidor de sinalização. Todo mundo abre um DataChannel WebRTC com ele. O host é a autoridade da sala: guarda membros, canais, histórico do chat e permissões.
- **A mídia vai em malha.** Voz, câmera e telas passam direto entre as pessoas (WebRTC, criptografado com DTLS-SRTP). O host não vê nem retransmite a mídia de ninguém.
- **Migração de host.** Cada participante guarda uma cópia do estado. Se o hub some, o membro mais antigo reserva o mesmo ID da sala e sobe um hub novo, e os outros reconectam sozinhos. Como o servidor de sinalização só deixa um peer usar cada ID, nunca existem dois hosts ao mesmo tempo.
- **Nada fica salvo em servidor.** Quando a última pessoa sai, a sala deixa de existir.

### Limites

- A malha P2P funciona melhor com até 6–8 pessoas com câmera ligada. Só com voz, aguenta mais gente.
- Na live, o upload de quem transmite é dividido entre os espectadores (em 720p, cerca de 2,5 Mbps por pessoa assistindo).
- Por padrão o app usa o servidor público do PeerJS e o TURN público do PeerJS. Para uso sério, rode os seus (veja abaixo).
- Os navegadores de celular não transmitem a tela, mas assistem lives normalmente.

## Rodando localmente

Precisa do Node.js 20.19+ (ou 22.12+).

```bash
npm install
npm run dev       # http://localhost:5173
npm run build     # gera dist/
npm run preview   # serve o build
```

Os navegadores só liberam microfone, câmera e tela em **HTTPS** ou em `localhost`. Para testar com outras pessoas, use o link publicado no GitHub Pages.

## Servidor de sinalização e TURN próprios (opcional)

```bash
npx -p peer peerjs --port 9000 --key peerjs --path /
```

Depois, no app, abra **Configurações › Rede** e informe host, porta, caminho e chave. Todo mundo da mesma sala precisa usar o mesmo servidor.

Em redes muito fechadas (4G, empresas, faculdades), um servidor TURN próprio (ex.: [coturn](https://github.com/coturn/coturn)) melhora a conexão. Cole a lista de servidores em JSON no campo **Servidores STUN/TURN**:

```json
[{ "urls": "stun:stun.l.google.com:19302" }, { "urls": "turn:seu-servidor:3478", "username": "usuario", "credential": "senha" }]
```

## Estrutura do código

```
src/
  lib/
    hub.ts         autoridade da sala (roda na aba do host)
    session.ts     conexão com o hub e migração de host
    media.ts       malha de voz/câmera e lives (WebRTC)
    wire.ts        canal JSON sobre DataChannel, com fatiamento de mensagens grandes
    protocol.ts    tipos das mensagens entre participantes e host
  components/      interface (React)
  controller.ts    liga a sessão, a mídia e a interface
  store.ts         estado da interface (Zustand)
```

Stack: React 19, TypeScript, Vite e PeerJS, com ícones do Lucide.

## Publicação

Cada push na branch `main` gera o build e publica no GitHub Pages (`.github/workflows/deploy.yml`).

## Licença

[MIT](LICENSE)
