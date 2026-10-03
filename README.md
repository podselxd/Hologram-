# Hologram

Overlay de escritorio controlado por manos. La webcam detecta hasta **dos manos** (MediaPipe Hands) y
dibuja sus 21 articulaciones como puntos azules cristalinos, con las líneas del esqueleto, sobre todo el
escritorio. La ventana es transparente, siempre visible y **deja pasar los clics**.

> **Estado: fase 1.** Overlay + tracking + benchmark + HUD. Todavía **no** controla el mouse, el scroll ni las
> ventanas (fases siguientes, ver más abajo).

## Descargar el .exe (Windows)

No necesitas Node ni `npm`. Un solo archivo, `Hologram.exe` (portable: no instala nada).

1. En GitHub, abre la sección **Releases** del repo y entra a **Hologram (latest build)**.
2. Descarga **`Hologram.exe`** y ábrelo con doble clic.

Se reconstruye solo en un servidor de Windows (GitHub Actions) en cada cambio de la rama. Arranca más
lento que una app instalada porque se extrae a una carpeta temporal cada vez.

El `.exe` **no está firmado**: Windows SmartScreen mostrará "Windows protegió su PC". Pulsa **Más información →
Ejecutar de todas formas**. Firmarlo cuesta dinero (certificado de firma de código). Para construirlo tú mismo:
`npm run dist:win` en Windows (genera `release/Hologram.exe`).

## Uso desde el código fuente

Requisitos: Windows 10/11 (objetivo principal), Node 22+, webcam.

```bash
npm install
npm start          # descarga el modelo la primera vez, compila y abre el overlay
```

| Atajo global | Acción |
|---|---|
| `Ctrl+Alt+O` | Mostrar / ocultar el overlay |
| `Ctrl+Alt+H` | Mostrar / ocultar el HUD |
| `Ctrl+Alt+C` | Cambiar de cámara |
| `Ctrl+Alt+B` | Repetir el benchmark |
| `Ctrl+Alt+Q` | Salir |

Opciones: `npm start -- --video=clip.webm` (usa un video en vez de la cámara), `--profile=low|medium|high`
(salta el benchmark), `--hands=1|2`, `--no-hud`.

## Cómo se adapta a tu equipo

Al iniciar, el **benchmark** pide que pongas las manos frente a la cámara unos segundos y mide el tiempo de
inferencia real en GPU y en CPU. Según el p95 elige perfil, delegado y número de manos:

| Perfil | Cámara pedida | Efectos | p95 de inferencia requerido |
|---|---|---|---|
| high | 1280×720 @ 60 | brillo + estela | ≤ 12 ms |
| medium | 640×480 @ 60 | brillo | ≤ 22 ms |
| low | 640×480 @ 30 | sin efectos, render al 75 % | ≤ 33 ms |

Si con 2 manos no llega a ≤ 40 ms, prueba con 1 mano. Si tampoco, la app **lo dice** ("no cumple el
mínimo") en vez de fingir. Si el benchmark se hizo sin manos a la vista, no se fía de sus números y usa el
perfil bajo. Los números crudos quedan en `benchmark.json` y `last-session.json` dentro de la carpeta de datos
de la app (`%APPDATA%/hologram` en Windows).

Además, el overlay baja efectos solo si los fotogramas se alargan (p95 > 22 ms) y los recupera tras 10 s
estables.

## Qué significa "60 FPS" aquí

- **Render del overlay:** objetivo 60 FPS limpios. Se dibuja con `requestAnimationFrame`, desacoplado del
  tracking, interpolando y prediciendo hasta 45 ms entre muestras de la cámara. Se mide con el **percentil 99
  del tiempo entre fotogramas** y el conteo de fotogramas > 33 ms (HUD), no con el promedio.
- **Tracking:** va al ritmo de **tu cámara** (muchas dan 30 FPS, y menos con poca luz) y de lo que tarde la
  inferencia. La interpolación hace que los puntos se vean fluidos, **pero la respuesta a tu mano no es más
  rápida que el tracking**.
- Un monitor de 60 Hz no muestra más de 60 FPS.

## Lo que está y no está verificado

Verificado en el entorno de desarrollo (Linux sin GPU, Electron bajo Xvfb, video de prueba): compilación,
typecheck, lint, 21 pruebas unitarias, carga del modelo y del wasm, benchmark con manos de una foto animada como video (no una persona en cámara),
selección de perfil y de delegado, retransmisión de manos al overlay, dibujo con transparencia y legibilidad
sobre fondo blanco, degradación adaptativa.

**No verificado** (no hay Windows, cámara ni GPU real en ese entorno):
- Cámara real, calidad de FPS y latencia en tu equipo.
- Consumo de CPU/RAM. No hay cifras medidas, así que este README no las promete.
- Ventana transparente y clic-a-través en Windows, DPI y varios monitores (solo el monitor principal por ahora).
- Linux/Wayland: la transparencia y el modo siempre-encima son poco fiables allí.

Limitaciones conocidas: el overlay no se ve sobre juegos o apps en pantalla completa exclusiva; con poca luz o
dedos superpuestos MediaPipe pierde puntos; en esta fase la cámara se estira sobre toda la pantalla (sin
calibración).

## Privacidad

Todo se procesa en local. No hay red en tiempo de ejecución (el modelo se descarga una vez con
`npm run fetch-model`), no se graba video y la cámara solo la abre la ventana oculta del tracker. La app solo
concede el permiso de cámara a esa ventana. Ventanas con `contextIsolation`, `sandbox`, sin `nodeIntegration`
y con política de contenido (CSP).

## Desarrollo

```bash
npm run check      # typecheck + lint + tests
npm run build
```

Ayudas de depuración: `HOLOGRAM_DEBUG=1` imprime estado, perfil y estadísticas; `HOLOGRAM_SHOT=ruta.png`
guarda una captura del overlay a los 25 s (`HOLOGRAM_SHOT_DELAY` en ms) y sale; `HOLOGRAM_DEBUG_BG=white`
pinta un fondo para revisar el contraste. Sin GPU real: `--use-gl=angle --use-angle=swiftshader
--enable-unsafe-swiftshader` (muy lento, solo para probar el flujo).

## Hoja de ruta

1. **Fase 1 (esta):** overlay, tracking, benchmark, HUD.
2. Calibración y mouse virtual (primero en modo dry-run), con modo "armado" y atajo de desarme.
3. Clic, arrastre, clic derecho, scroll tipo celular.
4. Gestos de ventanas (mover, `Alt+Tab`, cierre seguro con `WM_CLOSE`).
5. Bandeja del sistema, ajustes, instalador. Teclado/dictado después.

Licencias: MediaPipe y su modelo de manos son Apache-2.0.
