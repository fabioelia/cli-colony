import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: 'src/main/index.ts',
          'daemon/pty-daemon': 'src/daemon/pty-daemon.ts',
          'daemon/env-daemon': 'src/daemon/env-daemon.ts',
          'debug-mcp/server': 'src/debug-mcp/server.ts',
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    root: 'src/renderer',
    // Avoid sharing default 5173 with other Vite apps (wrong UI / blank page while dev URL mismatches).
    server: {
      port: 5173,
      strictPort: true,
    },
    build: {
      rollupOptions: {
        input: 'src/renderer/index.html'
      }
    },
    plugins: [react()]
  }
})
