import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The dev server runs on 5173 (the origin the API's CORS allows by default).
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
});
