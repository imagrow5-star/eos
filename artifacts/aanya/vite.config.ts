import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

import runtimeErrorOverlay from '@replit/vite-plugin-runtime-error-modal';

const rawPort = process.env.PORT;

if (!rawPort) {
  throw new Error(
    'PORT environment variable is required but was not provided.',
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH;

if (!basePath) {
  throw new Error(
    'BASE_PATH environment variable is required but was not provided.',
  );
}

// ─── Content-Security-Policy (Phase A privacy hardening) ──────────────────────
// Injected as a <meta> tag into PRODUCTION builds only (`apply: 'build'`) —
// the dev server needs Vite's inline HMR client, and the built app is served
// as static files so there is no server to add the header. frame-ancestors
// cannot be set via <meta>; noted on the API side instead.
const cspMetaPlugin = {
  name: 'inject-csp-meta',
  apply: 'build' as const,
  transformIndexHtml(html: string) {
    const csp = [
      "default-src 'self'",
      "script-src 'self'",
      // Tailwind/Framer set inline style attributes; Google Fonts serves the CSS
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data: blob:",
      "media-src 'self' blob: data:",
      // ElevenLabs realtime voice (websocket + REST, incl. regional/WebRTC hosts)
      "connect-src 'self' https://api.elevenlabs.io wss://api.elevenlabs.io https://*.elevenlabs.io wss://*.elevenlabs.io https://*.livekit.cloud wss://*.livekit.cloud",
      // ElevenLabs Conversational AI SDK inlines the rawAudioProcessor and
      // audioConcatProcessor worklet source into the JS bundle, then loads it
      // via URL.createObjectURL (blob:) with a data: base64 fallback for
      // Safari iframes. Chrome enforces script-src-elem (not worker-src) for
      // AudioWorklet module scripts; without an explicit script-src-elem it
      // falls back to script-src 'self', blocking the blob: worklet. Setting
      // script-src-elem explicitly keeps script-src tight.
      "script-src-elem 'self' blob: data:",
      "worker-src 'self' blob: data:",
      "manifest-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; ');
    return html.replace(
      '</title>',
      `</title>\n    <meta http-equiv="Content-Security-Policy" content="${csp}">`,
    );
  },
};

export default defineConfig({
  base: basePath,
  plugins: [
    cspMetaPlugin,
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
    ...(process.env.NODE_ENV !== 'production' &&
    process.env.REPL_ID !== undefined
      ? [
          await import('@replit/vite-plugin-cartographer').then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, '..'),
            }),
          ),
          await import('@replit/vite-plugin-dev-banner').then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      '@assets': path.resolve(
        import.meta.dirname,
        '..',
        '..',
        'attached_assets',
      ),
    },
    dedupe: ['react', 'react-dom'],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts: true,
    fs: {
      strict: true,
    },
  },
  preview: {
    port,
    host: '0.0.0.0',
    allowedHosts: true,
  },
});
