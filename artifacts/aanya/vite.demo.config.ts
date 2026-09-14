import path from 'path';
import { defineConfig } from 'vite';

// ─── The landing-page voice demo bundle ──────────────────────────────────────
// public/welcome.html is a static page, so the Hume call it makes needs a
// script at a FIXED path — not a hashed SPA chunk. This second build turns
// src/demo-voice/entry.ts (plus the Hume SDK and lib/humeVoice.ts) into
// dist/public/demo-voice.js, next to welcome.html. It runs after the main
// build (package.json "build"), which empties dist/public first; this one
// must not. Same engine floor as the SPA (see vite.config.ts).
//
// A preview build for reviewing the cutoff without Hume:
//   DEMO_VOICE_ENTRY=src/demo-voice/preview.ts vite build --config vite.demo.config.ts
export default defineConfig({
  root: path.resolve(import.meta.dirname),
  publicDir: false,
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: path.resolve(import.meta.dirname, process.env.DEMO_VOICE_OUT_DIR ?? 'dist/public'),
    emptyOutDir: false,
    target: ['es2019', 'chrome79', 'safari13'],
    lib: {
      entry: path.resolve(import.meta.dirname, process.env.DEMO_VOICE_ENTRY ?? 'src/demo-voice/entry.ts'),
      name: 'EosDemoVoice',
      formats: ['iife'],
      fileName: () => 'demo-voice.js',
    },
    sourcemap: false,
  },
});
