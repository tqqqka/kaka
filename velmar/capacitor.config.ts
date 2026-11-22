import type { CapacitorConfig } from '@capacitor/cli';

/** Конфигурация Capacitor: веб-сборка из dist/ упаковывается в Android-приложение. */
const config: CapacitorConfig = {
  appId: 'com.velmar.nighttide',
  appName: 'VELMAR',
  webDir: 'dist',
  android: {
    // WebGL2 и WASM работают в системном WebView (Chromium) Android 8+.
    allowMixedContent: false,
    backgroundColor: '#07080c',
  },
  plugins: {
    Preferences: {},
  },
};

export default config;
