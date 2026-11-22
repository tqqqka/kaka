import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `vite build` → обычная сборка в dist/ (для Capacitor/Android и хостинга).
// `vite build --mode single` → один самодостаточный HTML в dist-single/ (для публикации веб-версии).
export default defineConfig(({ mode }) => {
  const single = mode === 'single';
  return {
    base: './',
    plugins: single ? [viteSingleFile()] : [],
    build: {
      target: 'es2020',
      outDir: single ? 'dist-single' : 'dist',
      chunkSizeWarningLimit: 4000,
      assetsInlineLimit: single ? 100_000_000 : 4096,
      sourcemap: false,
    },
    server: { host: true },
  };
});
