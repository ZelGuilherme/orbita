/** Nas imagens dos planetas 3D, o planeta ocupa 1/THUMB_FRAME da largura (o resto é anel, lua…). */
export const THUMB_FRAME = 3.1;

let cached: boolean | null = null;

/** O navegador desenha em 3D (WebGL)? Sem isso, os planetas ficam no visual 2D. */
export function hasWebGL(): boolean {
  if (cached !== null) return cached;
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') ?? c.getContext('webgl');
    cached = !!gl;
    (gl as WebGLRenderingContext | null)?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    cached = false;
  }
  return cached;
}
