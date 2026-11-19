import { MAX_IMAGE_CHARS } from './config';
import type { Attachment } from './protocol';

/** Comprime uma imagem no navegador antes de mandar pelo P2P. */
export async function imageToAttachment(file: File): Promise<Attachment> {
  if (!file.type.startsWith('image/')) throw new Error('Só dá para enviar imagens.');
  if (file.size > 25 * 1024 * 1024) throw new Error('Imagem grande demais (máx. 25 MB).');

  // GIFs pequenos vão como estão, para manter a animação
  if (file.type === 'image/gif' && file.size * 1.37 < MAX_IMAGE_CHARS) {
    const dataUrl = await readAsDataUrl(file);
    const size = await measure(dataUrl);
    return { kind: 'image', name: file.name, dataUrl, ...size };
  }

  const source = await load(file);
  try {
    let maxSide = 1600;
    let quality = 0.85;
    for (let attempt = 0; attempt < 6; attempt++) {
      const scale = Math.min(1, maxSide / Math.max(source.width, source.height));
      const width = Math.max(1, Math.round(source.width * scale));
      const height = Math.max(1, Math.round(source.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const g = canvas.getContext('2d');
      if (!g) throw new Error('Seu navegador não conseguiu processar a imagem.');
      g.drawImage(source.image, 0, 0, width, height);
      let dataUrl = canvas.toDataURL('image/webp', quality);
      if (!dataUrl.startsWith('data:image/webp')) {
        g.globalCompositeOperation = 'destination-over';
        g.fillStyle = '#ffffff';
        g.fillRect(0, 0, width, height);
        dataUrl = canvas.toDataURL('image/jpeg', quality);
      }
      if (dataUrl.length <= MAX_IMAGE_CHARS) {
        const ext = dataUrl.startsWith('data:image/webp') ? 'webp' : 'jpg';
        return { kind: 'image', name: `${file.name.replace(/\.[^.]+$/, '') || 'imagem'}.${ext}`, dataUrl, width, height };
      }
      maxSide = Math.round(maxSide * 0.75);
      quality = Math.max(0.5, quality - 0.1);
    }
    throw new Error('Não consegui comprimir essa imagem o suficiente.');
  } finally {
    source.dispose();
  }
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Não consegui ler o arquivo.'));
    reader.readAsDataURL(file);
  });
}

async function measure(src: string): Promise<{ width: number; height: number }> {
  const img = new Image();
  img.src = src;
  await img.decode();
  return { width: img.naturalWidth, height: img.naturalHeight };
}

async function load(file: File): Promise<{ image: CanvasImageSource; width: number; height: number; dispose(): void }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file);
      return { image: bitmap, width: bitmap.width, height: bitmap.height, dispose: () => bitmap.close() };
    } catch {
      /* cai para o <img> */
    }
  }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch {
    URL.revokeObjectURL(url);
    throw new Error('Formato de imagem não suportado.');
  }
  return { image: img, width: img.naturalWidth, height: img.naturalHeight, dispose: () => URL.revokeObjectURL(url) };
}

/** Foto de perfil: recorta o centro num quadrado de 160x160 (webp, ou jpeg se não houver webp). */
export async function imageToAvatar(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Escolha um arquivo de imagem.');
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = 160;
  canvas.height = 160;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('Não consegui processar a imagem.');
  g.imageSmoothingQuality = 'high';
  g.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 160, 160);
  bitmap.close();
  let url = canvas.toDataURL('image/webp', 0.86);
  if (!url.startsWith('data:image/webp')) url = canvas.toDataURL('image/jpeg', 0.86);
  return url;
}
