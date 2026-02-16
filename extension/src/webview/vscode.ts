export type VSCodeApi = {
  postMessage: (msg: any) => void;
};

export function getVsCodeApi(): VSCodeApi {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const api = (globalThis as any).acquireVsCodeApi?.();
  return api ?? { postMessage: () => {} };
}
