import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

// React Flow relies on ResizeObserver in browsers.
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// Basic polyfills for webview-like environment.
vi.stubGlobal("ResizeObserver", ResizeObserverMock as any);
vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0) as any);
vi.stubGlobal("cancelAnimationFrame", (id: any) => clearTimeout(id));

// acquireVsCodeApi must exist before App.tsx imports (it is read at module scope).
vi.stubGlobal("acquireVsCodeApi", () => ({
  postMessage: vi.fn()
}));

// Some libs check for matchMedia.
vi.stubGlobal("matchMedia", (query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false
}));
