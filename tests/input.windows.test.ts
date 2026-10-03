import { describe, expect, it } from 'vitest';
import { createMouseInput } from '../src/main/input';

describe('mouse input module', () => {
  it.skipIf(process.platform === 'win32')('reports itself unavailable outside Windows', async () => {
    const m = await createMouseInput();
    expect(m.available).toBe(false);
    expect(m.error).toMatch(/Windows/);
  });

  it.skipIf(process.platform !== 'win32')('loads user32 through koffi on Windows', async () => {
    const m = await createMouseInput();
    expect(m.error).toBeUndefined();
    expect(m.available).toBe(true);
    // Reading the cursor position must not throw (a headless runner may return null).
    expect(() => m.cursorPos()).not.toThrow();
  });
});
