# Hologram

Overlay de escritorio controlado por manos. La webcam detecta hasta **dos manos** (MediaPipe Hands) y
dibuja sus 21 articulaciones como puntos azules cristalinos, con las líneas del esqueleto, sobre todo el
escritorio. La ventana es transparente, siempre visible y **deja pasar los clics**.

> **Estado: fase 2.** Overlay, tracking, ventana de ajustes y **control del mouse con las manos** (mover, clic, doble clic, arrastrar, clic derecho, scroll). Todavía no hay gestos de ventanas (`Alt+Tab`, etc.). Antes: no controlaba el mouse, el scroll ni las
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

## Actualizaciones automáticas

El `.exe` portable busca versiones nuevas al abrir y cada 6 horas. Hay dos modos (ventana de ajustes →
Actualizaciones; por defecto **automático**):

- **Automático:** descarga y verifica la versión nueva en segundo plano y la **instala al salir de Hologram**
  (bandeja → *Salir de Hologram*; cerrar la ventana no sale), o ya con *Reiniciar ahora* (se cierra y se vuelve a
  abrir sola en ~30 s). Avisa con notificaciones en cada paso; si abres otra copia mientras instala, esa copia espera
  en vez de bloquear el archivo. Cada paso queda en `update-swap.log` y, si falla, la app te dice por qué.
- **Preguntar:** no hace nada sin tu clic (*Descargar actualización*, luego *Reiniciar para actualizar*).

Protecciones:
- Solo mira los **releases con versión** (`v0.3.0`…), no el build de desarrollo `hologram-latest`.
- **Un salto de versión mayor** (0.x → 1.x) nunca se instala solo.
- La descarga se verifica con SHA-256 y tamaño, y se **recalcula el hash antes de instalar**.
- **Vuelta atrás automática:** la versión nueva escribe una marca "arranqué bien" a los 20 s. Si no aparece en 90 s,
  el script cierra la nueva, restaura `Hologram.old.exe` y te avisa. Si algo falla 2 veces, deja de intentarlo.
- *Volver a la versión anterior* en la bandeja o en los ajustes, a mano, cuando quieras.
- Los fallos quedan en `update.log` (carpeta de datos); la app sigue con la versión actual.

Para publicar una versión, **sube el número en `package.json`**: cuando los tests y el build de Windows pasan, el
CI publica `vX.Y.Z` solo (nunca sobrescribe una versión ya publicada). También sirve crear la release a mano con
un tag `v*`. Solo funciona ejecutando el portable (necesita su ruta original); desde el código fuente está
desactivado.

Límites: el `.exe` **no está firmado**, así que la seguridad depende de tu cuenta de GitHub (el SHA-256 detecta
corrupción, no prueba quién publicó). Verificado en Windows (CI): el script de reemplazo, la espera a que el
proceso salga, el respaldo, la marca de arranque y la vuelta atrás con archivos falsos. **No verificado:** una
actualización real de extremo a extremo con el portable de electron-builder y antivirus; la primera instalación
automática real será de 0.2.1 a la siguiente versión (0.2.0 solo sabe el modo "preguntar").

## Uso desde el código fuente

Requisitos: Windows 10/11 (objetivo principal), Node 22+, webcam.

```bash
npm install
npm start          # descarga el modelo la primera vez, compila y abre el overlay
```

## Ventana de ajustes

Se abre sola al iniciar, al hacer clic en el icono de la bandeja, con `Ctrl+Alt+S` o al volver a lanzar el
`.exe`. Cerrarla **no** cierra la app. Contiene:

- **Vista en vivo de tus manos:** el esqueleto de cada mano en tiempo real (con el efecto espejo y los colores
  elegidos) y, si lo activas, también la imagen de la cámara para revisar encuadre y luz. La imagen solo se
  procesa mientras la ventana está abierta, a baja resolución, y no se guarda.
- **Estado:** perfil y veredicto del benchmark, FPS y resolución de la cámara, tiempo de inferencia, FPS y
  percentil 99 del render, latencia estimada y manos perdidas en los últimos 5 s.
- **Cámara y rendimiento:** elegir cámara, perfil (automático, bajo, medio, alto), 1 o 2 manos y repetir el
  benchmark con sus mediciones.
- **Apariencia:** color (azul, cian, violeta, verde), tamaño de los puntos, suavizado (menos temblor frente a
  menos retraso) y efecto espejo.
- **Actualizaciones**, **modo seguro** y la lista de atajos.

Los cambios se aplican al momento y se guardan en `settings.json`. Teclado: todo es navegable con Tab, con foco
visible y etiquetas en cada control.

**Segundo plano:** la app deja un icono en la bandeja del sistema (junto al reloj). Clic en el icono: mostrar u
abrir la ventana de ajustes. Clic derecho: overlay, cambiar de cámara, repetir benchmark, modo seguro y **Salir de Hologram**.
Con el overlay oculto la **cámara se apaga** (no se captura nada) y se reactiva al mostrarlo.

**Si el overlay parpadea:** mira en la ventana de ajustes "Manos perdidas". Si es alto, el parpadeo es tracking inestable
(poca luz, cámara de pocos FPS), no un fallo de dibujo. Si es 0 y sigue parpadeando, activa **Modo seguro** en el
menú de la bandeja y reinicia la app: desactiva la aceleración por hardware (la inferencia pasa a CPU, más lenta).

| Atajo global | Acción |
|---|---|
| `Ctrl+Alt+O` | Mostrar / ocultar el overlay |
| `Ctrl+Alt+S` | Abrir la ventana de ajustes |
| `Ctrl+Alt+C` | Cambiar de cámara |
| `Ctrl+Alt+B` | Repetir el benchmark |
| `Ctrl+Alt+Q` | Salir |

Opciones: `npm start -- --video=clip.webm` (usa un video en vez de la cámara), `--profile=low|medium|high`
(salta el benchmark; el perfil queda marcado como "sin verificar"), `--hands=1|2`, `--safe-render`.

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

## Control con las manos

Ventana de ajustes → **Control con las manos**:

- **Modo:** *Desactivado* · *Prueba* (por defecto: dibuja un cursor virtual en pantalla, no toca el mouse) ·
  *Activado* (mueve el mouse real).
- **El cursor sigue tu mano en todo momento** (con *Activado*). `Ctrl+Alt+D` o el botón lo **pausan** y reanudan.
  Opcional: *Pedir armado con la palma* (palma abierta 1 s para armar/desarmar). Al pausar o salir, nunca deja el
  botón del mouse apretado.
- **Gestos:** el cursor sigue el punto entre pulgar e índice; pinza pulgar+índice = clic (y arrastre si mueves la
  mano); dos pinzas rápidas = doble clic; pulgar+medio = clic derecho; índice y medio extendidos = scroll que sigue a
  la mano, con inercia.
- **Calibración:** mano que controla, tamaño y altura de la **zona de control** (rectángulo amarillo en la vista en
  vivo: más pequeña = menos movimiento de brazo) y sensibilidad de la pinza.
- **Cómo:** el cursor se suaviza a ~60 Hz a partir del tracking (≤ 30 lecturas/s con una webcam de 30 FPS); la
  entrada real usa `SetCursorPos`/`mouse_event` de `user32` vía `koffi`.

Límites reales: menos preciso que un mouse (botones pequeños fallarán); no controla ventanas de administrador ni
juegos en pantalla completa exclusiva; cansa el brazo. Verificado: la lógica de gestos con 15 pruebas de secuencias
sintéticas, el cursor virtual y la interfaz en la app real con cámara simulada, y (en el CI de Windows) que el `.exe`
empaquetado carga `koffi` + `user32`. **No verificado:** mover tu mouse real con tus manos en tu PC.

## Cámara: cómo se leen los FPS

La ventana de ajustes separa tres números (antes salían mezclados en uno):

- **Entregados:** cuadros que la cámara produce por segundo (estadísticas de la pista de video de Chromium).
- **Pide:** el modo que la cámara aceptó (resolución y FPS) y su máximo declarado.
- **Procesados:** cuadros que el modelo de manos alcanzó a analizar. Si es menor que "entregados", el límite es la
  inferencia, no la cámara.

Los cuadros se leen **directamente de la cámara** (`MediaStreamTrackProcessor`), sin pasar por un `<video>` en una
ventana oculta: Windows frena las ventanas ocultas u ocultadas y eso podía bajar la cámara a ~15 FPS dentro de la
app aunque la misma cámara fuera bien en otras apps. Además la app desactiva ese frenado de Chromium
(`CalculateNativeWinOcclusion`, background/occluded throttling) y decodifica la cámara por software
(sin captura D3D11 ni MJPEG por GPU), porque con algunas webcams ese camino de Windows entrega la mitad de cuadros
(15 en vez de 30) mientras que en modo seguro llegaban 30; la GPU sigue libre para el modelo. Si aun así no llega,
hay un **método de captura "Compatible" (DirectShow)** en los ajustes (requiere reiniciar). El límite duro es el
máximo de la cámara: una webcam de 30 FPS no puede dar 50 lecturas reales por segundo. Si la cámara entrega menos de 24 FPS, la app
**prueba otros modos** (1280×720, 640×480, 848×480, 640×360, 320×240 pidiendo 30 FPS) y se queda con el más rápido;
el resultado aparece en el diagnóstico. Verificado con una cámara simulada a 30 FPS (entregados 30, procesados según
la GPU). **No verificado en Windows con tu cámara:** es justo lo que hay que confirmar.

## Qué significa "60 FPS" aquí

- **Render del overlay:** objetivo 60 FPS limpios. Se dibuja con `requestAnimationFrame`, desacoplado del
  tracking, interpolando y prediciendo hasta 45 ms entre muestras de la cámara. Se mide con el **percentil 99
  del tiempo entre fotogramas** y el conteo de fotogramas > 33 ms (ventana de ajustes), no con el promedio.
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

El procesamiento de la cámara es local: no se graba ni se guarda video, y la cámara solo la abre la ventana
oculta del tracker (el permiso de cámara se concede únicamente a esa ventana). Con el overlay oculto la cámara
se apaga.

Conexiones de red de la app:
- **Actualizaciones:** consulta `api.github.com` (repo público) al abrir y cada 6 h, y descarga desde
  `github.com` solo si tú lo pides. Se puede ver en `update.log`.
- **MediaPipe** intenta enviar un registro de uso a `odml.pa.googleapis.com`. La política de contenido (CSP) de
  la app **lo bloquea** (se ve como error de CSP en el log de depuración): no sale nada. Si cambias la CSP,
  vuelve a comprobarlo.
- El modelo de manos se descarga una vez con `npm run fetch-model` (al construir, no al ejecutar el `.exe`).

Seguridad: ventanas con `contextIsolation`, `sandbox`, sin `nodeIntegration` y con CSP. Los mensajes entre
procesos se validan y se comprueba qué ventana los envía (solo la ventana de ajustes puede cambiar ajustes o
pedir acciones).

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

1. **Fase 1 (esta):** overlay, tracking, benchmark, ventana de ajustes.
2. Calibración y mouse virtual (primero en modo dry-run), con modo "armado" y atajo de desarme.
3. Clic, arrastre, clic derecho, scroll tipo celular.
4. Gestos de ventanas (mover, `Alt+Tab`, cierre seguro con `WM_CLOSE`).
5. Bandeja del sistema, ajustes, instalador. Teclado/dictado después.

Licencias: MediaPipe y su modelo de manos son Apache-2.0.
