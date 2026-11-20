declare const __APP_BUILD__: string;

/** Identificador desta versão do Órbita (muda a cada publicação). */
export const APP_BUILD: string = __APP_BUILD__;

/** Essa pessoa está com outra versão do Órbita? (sem versão = uma versão antiga) */
export const otherBuild = (build: string | undefined) => build !== APP_BUILD;
