/// <reference types="vite/client" />
/// <reference types="electron-vite/node" />

// vite/client types `*.css` but not the `?inline` query variant (raw text
// import, no injection). Declared once here for whoever imports one.
declare module '*.css?inline' {
  const css: string
  export default css
}

// AudioWorklet globals. TypeScript's DOM lib omits them because they exist only
// inside the worklet scope, and each worklet file declaring its own copy is a
// duplicate-identifier error at global scope -- so they live here once.
declare const sampleRate: number
declare class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor()
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean
}
declare function registerProcessor(
  name: string,
  ctor: new (options?: { processorOptions?: Record<string, unknown> }) => AudioWorkletProcessor
): void
