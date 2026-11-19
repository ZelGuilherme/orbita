/**
 * Qualidade da live.
 *
 * Sem ajuda, o WebRTC começa a live estimando uns 300 kbps: o codificador parte de uma
 * resolução bem baixa (640x360 numa live de 1080p) e demora muito para subir. Aqui:
 * - o SDP já combina uma taxa inicial alta (x-google-start-bitrate), então a imagem começa
 *   na resolução escolhida;
 * - a resolução escolhida é mantida (com pouca banda cai a taxa de quadros, não a imagem);
 * - o codec padrão é o VP8. Nos testes, os codificadores por hardware (H.264/VP9 da Intel)
 *   estouravam a taxa e o controle de banda derrubava a qualidade; quem quiser testar outro
 *   codec escolhe em Configurações › Lives.
 */

export type VideoCodec = 'H264' | 'VP9' | 'AV1' | 'VP8';

const MEDIA_CODECS = new Set(['VP8', 'VP9', 'H264', 'AV1']);

/** Reescreve a parte de vídeo do SDP (oferta ou resposta) de uma live. */
export function tuneLiveSdp(sdp: string, bitrate: number, prefer?: VideoCodec | null): string {
  const startKbps = Math.max(300, Math.round((bitrate * 0.8) / 1000));
  const sections = sdp.split(/\r\n(?=m=)/);
  return sections
    .map((section) => {
      if (!section.startsWith('m=video')) return section;
      const lines = section.split('\r\n');
      const codecOf = new Map<string, string>();
      for (const line of lines) {
        const m = /^a=rtpmap:(\d+) ([\w-]+)\//.exec(line);
        if (m) codecOf.set(m[1], m[2].toUpperCase());
      }
      const media = [...codecOf].filter(([, codec]) => MEDIA_CODECS.has(codec)).map(([pt]) => pt);
      const param = `x-google-start-bitrate=${startKbps}`;
      for (const pt of media) {
        const fmtp = lines.findIndex((l) => l.startsWith(`a=fmtp:${pt} `));
        if (fmtp >= 0) {
          if (!lines[fmtp].includes('x-google-start-bitrate')) lines[fmtp] += `;${param}`;
        } else {
          const rtpmap = lines.findIndex((l) => l.startsWith(`a=rtpmap:${pt} `));
          lines.splice(rtpmap + 1, 0, `a=fmtp:${pt} ${param}`);
        }
      }
      if (prefer && prefer !== 'VP8') {
        const mline = lines[0].split(' ');
        const pts = mline.slice(3);
        const first = new Set(pts.filter((pt) => codecOf.get(pt) === prefer));
        if (first.size) {
          // o RTX de cada codec preferido vai junto
          for (const line of lines) {
            const m = /^a=fmtp:(\d+) apt=(\d+)/.exec(line);
            if (m && first.has(m[2])) first.add(m[1]);
          }
          lines[0] = [...mline.slice(0, 3), ...pts.filter((pt) => first.has(pt)), ...pts.filter((pt) => !first.has(pt))].join(' ');
        }
      }
      return lines.join('\r\n');
    })
    .join('\r\n');
}

/** Codecs de vídeo que este navegador sabe enviar. */
export function availableCodecs(): VideoCodec[] {
  const list = RTCRtpSender.getCapabilities?.('video')?.codecs ?? [];
  return (['VP8', 'VP9', 'H264', 'AV1'] as const).filter((c) => list.some((x) => x.mimeType.toUpperCase() === `VIDEO/${c}`));
}
