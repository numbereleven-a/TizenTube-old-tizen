import i18n from 'i18next';
import resources from './i18nResources.js';

// Keep the region: pt-BR, pt-PT and es-419 only exist with it, and i18next falls back to the bare language by itself.
InitI18next((window?.yt?.config_?.HL || navigator.language || '').replace('_', '-'));

function InitI18next(lng) {
  i18n
    .init({
      lng,
      fallbackLng: 'en',
      resources,
      debug: false,
      interpolation: {
        escapeValue: false,
      }
    });
}
export default i18n;