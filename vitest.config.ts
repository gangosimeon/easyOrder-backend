import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Même alias que tsconfig.json (`@/` = racine du projet)
  resolve: { alias: { '@': path.resolve(__dirname) } },
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    // Une base en mémoire par fichier de test : on évite les fichiers en parallèle.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,   // premier lancement : téléchargement du binaire MongoDB
  },
});
