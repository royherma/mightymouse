import { resolve } from 'path'
import { defineConfig, type UserConfig } from 'vite'
import app from '../../electron.vite.config'

const renderer = (app as { renderer: UserConfig }).renderer

export default defineConfig({
  ...renderer,
  root: resolve(__dirname),
  server: { port: 5004, strictPort: true, hmr: { overlay: false } }
})
