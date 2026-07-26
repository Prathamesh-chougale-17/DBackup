import { vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';

// Polyfill ResizeObserver for Radix UI components (Select, etc.)
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Browser globals for UI components. Guarded because a test file can opt out of jsdom with
// `// @vitest-environment node`, and this setup runs for those too - unguarded, it took the
// whole file down before a single test ran.
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation(query => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(), // deprecated
      removeListener: vi.fn(), // deprecated
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

// Reset Mocks vor jedem Test
beforeEach(() => {
  vi.clearAllMocks();
});