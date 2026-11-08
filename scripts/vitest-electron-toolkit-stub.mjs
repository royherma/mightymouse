// Stands in for `@electron-toolkit/utils` when vitest imports a main-process
// module (see the alias in vitest.config.ts). The real package reads named
// exports off the `electron` CJS binary, which Node cannot resolve outside
// Electron -- so one transitive import of it failed whole suites at COLLECTION
// with "Named export 'BrowserWindow' not found", naming a file the test never
// meant to load. Only `is.dev` is read anywhere in src/main.
export const is = { dev: false }
export const platform = {
  isWindows: process.platform === 'win32',
  isMacOS: process.platform === 'darwin',
  isLinux: process.platform === 'linux'
}
export const electronApp = { setAppUserModelId() {} }
export const optimizer = { watchWindowShortcuts() {} }
