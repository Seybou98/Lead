/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Port dédié : une origine différente du CRM principal (5173 ; l'ancien CRM : 5174) évite de partager sa session
  // Firebase Auth, qui est stockée par origine dans le navigateur.
  server: { port: 5180, strictPort: true },
  optimizeDeps: {
    exclude: ['lucide-react'],
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'functions/src/**/*.test.ts', 'netlify/**/*.test.ts'],
  },
});
