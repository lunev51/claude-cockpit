'use strict';
// Выбор TTS-провайдера и обёртка с автофоллбэком.

const piper = require('./piper');
const silero = require('./silero');

const PROVIDERS = { piper, silero };

// Колбэк уведомлений (main подставляет notify через setNotifier). По умолчанию
// no-op, чтобы модуль оставался независимым и тестируемым в отрыве от Electron.
let notifier = () => {};
function setNotifier(fn) {
  if (typeof fn === 'function') notifier = fn;
}

// Заметный фоллбэк показываем один раз за сессию — не спамим на каждый запрос.
let fallbackNoticeShown = false;

function getTtsProvider(cfg) {
  const engine = (cfg && cfg.engine) || 'piper';
  return PROVIDERS[engine] || piper;
}

// speak(text, cfg, lang) → Promise<Buffer> (WAV).
// lang==='en': сразу piper (silero ru не умеет английский), без фоллбэка.
// lang==='ru': основной движок, при ошибке — один раз cfg.fallback.
async function speak(text, cfg, lang = 'ru') {
  const config = cfg || {};

  if (lang === 'en') {
    return piper.synthesize(text, config, 'en');
  }

  const primary = getTtsProvider(config);
  try {
    return await primary.synthesize(text, config, 'ru');
  } catch (err) {
    console.warn(`[tts] движок «${config.engine}» упал: ${err.message}`);
    const fallbackName = config.fallback;
    const fallback = fallbackName && PROVIDERS[fallbackName];
    if (!fallback || fallback === primary) throw err;
    console.warn(`[tts] фоллбэк на «${fallbackName}»`);
    if (!fallbackNoticeShown) {
      fallbackNoticeShown = true;
      // Краткая причина: первая строка сообщения ошибки.
      const reason = String(err.message || '').split('\n')[0].slice(0, 80);
      notifier(`движок ${config.engine} недоступен (${reason}) — говорю через ${fallbackName}`, 'warn');
    }
    return fallback.synthesize(text, config, 'ru');
  }
}

module.exports = { getTtsProvider, speak, setNotifier };
