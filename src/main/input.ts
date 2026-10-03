/**
 * Real mouse input on Windows through user32 (koffi FFI). Loaded lazily: if anything fails the app keeps working
 * and the settings window shows why the real mouse is unavailable. No Electron imports, so it can be tested.
 */
export interface MouseInput {
  available: boolean;
  error?: string;
  moveTo(x: number, y: number): void;
  leftDown(): void;
  leftUp(): void;
  rightClick(): void;
  /** Positive = scroll up (content moves down), like a wheel; 120 = one notch. */
  wheel(delta: number): void;
  cursorPos(): { x: number; y: number } | null;
}

const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_RIGHTDOWN = 0x0008;
const MOUSEEVENTF_RIGHTUP = 0x0010;
const MOUSEEVENTF_WHEEL = 0x0800;

const unavailable = (error: string): MouseInput => ({
  available: false,
  error,
  moveTo: () => undefined,
  leftDown: () => undefined,
  leftUp: () => undefined,
  rightClick: () => undefined,
  wheel: () => undefined,
  cursorPos: () => null,
});

export async function createMouseInput(): Promise<MouseInput> {
  if (process.platform !== 'win32') return unavailable('El control del mouse solo funciona en Windows.');
  try {
    const koffi = (await import('koffi')).default;
    const user32 = koffi.load('user32.dll');
    const SetCursorPos = user32.func('bool __stdcall SetCursorPos(int x, int y)');
    const mouseEvent = user32.func(
      'void __stdcall mouse_event(uint32_t dwFlags, uint32_t dx, uint32_t dy, int32_t dwData, uintptr_t dwExtraInfo)',
    );
    koffi.struct('HOLOGRAM_POINT', { x: 'long', y: 'long' }); // registers the type used below
    const GetCursorPos = user32.func('bool __stdcall GetCursorPos(_Out_ HOLOGRAM_POINT *pos)');
    return {
      available: true,
      moveTo: (x, y) => void SetCursorPos(Math.round(x), Math.round(y)),
      leftDown: () => mouseEvent(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0),
      leftUp: () => mouseEvent(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0),
      rightClick: () => {
        mouseEvent(MOUSEEVENTF_RIGHTDOWN, 0, 0, 0, 0);
        mouseEvent(MOUSEEVENTF_RIGHTUP, 0, 0, 0, 0);
      },
      wheel: (delta) => mouseEvent(MOUSEEVENTF_WHEEL, 0, 0, Math.round(delta), 0),
      cursorPos: () => {
        const p: { x?: number; y?: number } = {};
        return GetCursorPos(p) && typeof p.x === 'number' && typeof p.y === 'number' ? { x: p.x, y: p.y } : null;
      },
    };
  } catch (err) {
    return unavailable(`No pude cargar el control del mouse: ${String(err)}`);
  }
}
