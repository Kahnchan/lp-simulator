import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { localRpcPlugin } from "./server/localRpc";
export default defineConfig({
  plugins: [react(), localRpcPlugin()],
  define: { __LOCAL_RPC_PROXY__: "true" },
  server: { host: "127.0.0.1", port: 5174, strictPort: true },
  preview: { host: "127.0.0.1", port: 4174, strictPort: true },
});
