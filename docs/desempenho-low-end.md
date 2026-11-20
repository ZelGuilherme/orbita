# Desempenho em computadores fracos (medições de 20/11/2026)

Medições feitas com `tests/perf/lowend.mjs`. O script usa o build de produção (sem minificar) e
uma sala com usuários falsos de microfone ligado. Duas janelas medem: uma com a GPU da máquina e
outra **sem GPU** (`--disable-gpu`, com WebGL feito por software no SwiftShader, como uma placa
fraca). A CPU fica 1x, 4x e 6x mais lenta pelo DevTools (`Emulation.setCPUThrottlingRate`).

Máquina usada: Intel UHD Graphics, 4 núcleos e **cerca de 1 GB de RAM livre**. Com mais de 7
navegadores abertos ela começou a usar o disco como memória e as medições perderam o sentido.
Por isso os números abaixo vêm só das rodadas limpas: 6 usuários falsos na tabela 1 e 3 nas
tabelas 2 e 3.

## 1. Chamada sem live (6 pessoas), fps e pior quadro

| Janela | CPU | 3D | 2D | Anéis |
|---|---|---|---|---|
| GPU normal | 1x | 53 fps, travada de 0,6 s ao abrir | 60 | 60 |
| GPU normal | 4x | 39 fps, **travada de 8,5 s** ao abrir | 56 | 57 |
| GPU normal | 6x | 19 fps, travada de 3,2 s | 52 | 60 |
| sem GPU | 1x | **4 fps** | 58 | 60 |
| sem GPU | 4x | 7 fps | 57 | 58 |
| sem GPU | 6x | 7 fps | 60 | 59 |

Thread principal ocupada: 3D de 38% a 300%, 2D de 23% a 67%, anéis de 5% a 17%.

Sem GPU, só **entrar na sala** já levou de 39 s a 162 s com o 3D sendo o padrão. Entrando pelo
modo anéis, a janela com GPU entrou em 10 a 22 s.

## 2. O que o perfil de CPU mostrou (GPU normal, CPU 4x, 3 pessoas)

| Momento | fps | Ocupado | Quem pesa |
|---|---|---|---|
| Entrar no 3D | 51, travada de 0,6 s | 84% | `getProgramInfoLog` = **650 ms** (6% de tudo) |
| 3D aberto | 56 | 61% | `(program)` 34%, `placeLabels` (Orbit3D), `renderBufferDirect` |
| 2D | 57 | 47% | `(program)` 31%, o laço de `transformOf` (CallView), ícones lucide sendo recriados |
| Anéis | 57 | 29% | `(program)` 17%, `SignalBars`, `renderWithHooks` |

`(program)` é trabalho do próprio navegador (pintura, composição e comandos para a GPU), não
JavaScript. É ele que domina em todos os modos.

## 3. Com live no ar (a órbita vira a faixa de baixo), CPU 4x

| Modo | fps | Observação |
|---|---|---|
| Entrar no 3D | 54 | ok |
| 3D | 50 | ok |
| **2D** | **2**, quadro de 7 s | o JavaScript ficou em só 5%: o custo é de pintura e composição ou de memória. **Precisa confirmar.** |
| Anéis | não medido | a medição foi interrompida aqui |

## Causas e o que fazer (em ordem de impacto)

1. **3D sem GPU é inviável (4 a 7 fps) e é o modo padrão.** Detectar WebGL por software
   (`UNMASKED_RENDERER_WEBGL` contendo `SwiftShader`, `llvmpipe` ou `Microsoft Basic Render`) e
   começar no modo anéis, ou no 2D, quando for o caso. Hoje `hasWebGL()` só confere se existe
   WebGL.
2. **Travada ao abrir o 3D** (0,6 s com CPU normal e até 8,5 s com CPU 4x). Parte vem de
   `getProgramInfoLog`: o three.js confere erros de shader e isso força uma compilação síncrona.
   Em produção dá para usar `renderer.debug.checkShaderErrors = false` e
   `renderer.compileAsync(scene, camera)` antes do primeiro quadro. Falta medir de novo depois.
3. **2D com live no ar caiu para 2 fps.** Investigar se as camadas da faixa de planetas
   (transform a cada quadro por cima do `<video>`) forçam pintura demais. Testar com
   `contain: paint` e `will-change` na faixa, ou parar o laço do 2D quando ele estiver na faixa.
4. **Re-render por quem está falando.** O estado `speaking` muda cerca de 8 vezes por segundo
   com 3 pessoas falando, e cada mudança renderiza a lista de pessoas de novo (`SignalBars` e
   ícones lucide aparecem no perfil). Dá para isolar os seletores ou usar `memo` nos itens.
5. **`placeLabels` no 3D roda a cada quadro.** Atualizar os nomes só quando a posição mudar mais
   de 1 px, ou com menos frequência.

## Como continuar

```bash
npm ci
LEAN=1 node tests/perf/lowend.mjs 3     # máquina com pouca RAM: só a janela com GPU
node tests/perf/lowend.mjs 6            # máquina com folga: as duas janelas, 6 pessoas
node tests/perf/demo-sala.mjs 8         # abre uma sala com 8 pessoas falsas para olhar
```

Os resultados ficam em `test-results/perf/`: em `lowend.json` e `lowend-profiles.json`, com as
funções que mais pesam em cada caso.

O e2e (`npm run test:e2e`) falhou nesta máquina antes de chegar aos modos. Os dois pontos que
quebraram dependem de tempo: o envio de um arquivo de 24 MB (`setInputFiles` levou mais de 30 s)
e a reação arrastada até um planeta em movimento no 3D. Vale rodar de novo numa máquina com mais
memória.
