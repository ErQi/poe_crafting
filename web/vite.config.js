import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

const host = "127.0.0.1";
const port = 5173;

export default defineConfig({
  plugins: [vue()],
  base: "./",
  server: {
    host,
    port,
    strictPort: true,
    origin: `http://${host}:${port}`,
    hmr: { protocol: "ws", host, port, clientPort: port },
    watch: { usePolling: process.platform === "win32", interval: 300 },
  },
  clearScreen: false,
});

