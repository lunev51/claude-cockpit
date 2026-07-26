// Точка входа renderer: получает конфиг через preload-мост,
// собирает вместе терминал и аватар. Сами модули ничего не знают друг о друге.

import { initTerminal } from './terminal.js';
import { initAvatar } from './avatar/avatar.js';
import { VoiceRecorder } from './voice/recorder.js';
import { VoiceOut } from './voice/voiceout.js';
import { WakeListener } from './voice/wakelistener.js';

const $ = (id) => document.getElementById(id);

async function main() {
  const config = await window.api.config.get();

  // --- раскладка: сторона и ширина панели аватара из конфига ---
  const avatarPane = $('avatar-pane');
  const splitter   = $('splitter');
  const appEl      = $('app');

  avatarPane.style.flexBasis = `${config.avatar.widthPercent}%`;

  const side = config.avatar.side || 'right';
  if (side === 'left') {
    appEl.style.flexDirection = 'row-reverse';
    avatarPane.style.borderLeft  = 'none';
    avatarPane.style.borderRight = '1px solid #2f334d';
  }

  // --- Тосты уведомлений (main→renderer через 'app:notice') ---
  // Стек в правом верхнем углу терминальной панели; максимум 3, автоскрытие 8с.
  const toastStack = (() => {
    const host = document.createElement('div');
    host.style.cssText = [
      'position:absolute', 'top:8px', 'right:8px', 'z-index:9999',
      'display:flex', 'flex-direction:column', 'gap:6px',
      'max-width:340px', 'pointer-events:none',
    ].join(';');
    // Крепим к терминальной панели (или к body, если её нет).
    const anchor = $('terminal-pane') || $('terminal')?.parentElement || document.body;
    if (getComputedStyle(anchor).position === 'static') anchor.style.position = 'relative';
    anchor.appendChild(host);
    return host;
  })();

  function showToast({ text, level } = {}) {
    if (!text) return;
    while (toastStack.children.length >= 3) toastStack.removeChild(toastStack.firstChild);
    const el = document.createElement('div');
    const border = level === 'error' ? '#e26a75' : '#1f1f2a';
    el.textContent = String(text);
    el.style.cssText = [
      'background:#12121a', `border:1px solid ${border}`, 'color:#c7cad1',
      'padding:8px 10px', 'border-radius:6px', 'font-size:12px',
      'line-height:1.35', 'box-shadow:0 4px 14px rgba(0,0,0,.4)',
      'pointer-events:auto', 'word-break:break-word',
    ].join(';');
    toastStack.appendChild(el);
    setTimeout(() => { try { el.remove(); } catch { /* */ } }, 8000);
  }
  window.api.app?.onNotice?.(showToast);

  // --- терминал (этап 1) ---
  $('status-font').textContent = `A ${config.terminal.fontSize}px`;

  // --- индикатор рабочей папки в статус-баре ---
  const cwdEl = $('status-cwd');
  function updateCwdLabel(cwd) {
    if (!cwdEl || !cwd) return;
    // Показываем только последний сегмент пути
    cwdEl.textContent = `📁 ${cwd.replace(/\\/g, '/').split('/').pop() || cwd}`;
  }
  updateCwdLabel(config.terminal.cwd);
  cwdEl?.addEventListener('click', async () => {
    const dir = await window.api.workdir.choose();
    if (dir) updateCwdLabel(dir);
  });

  window.terminal = initTerminal($('terminal'), config, {
    onPtyStatus: (text) => { $('status-pty').textContent = `⌨ ${text}`; },
    onFontSize:  (size) => { $('status-font').textContent = `A ${size}px`; },
  });

  // --- Удалённая команда (Telegram-Избранное → main → cmd:inject) ---
  // Вставляем текст в терминал и жмём Enter — та же логика, что у голосового
  // submit(). Объявлено в main()-скоупе, чтобы работало независимо от STT.
  window.api.cmd?.onInject?.(({ text } = {}) => {
    const t = (text ?? '').trim();
    if (!t || !window.terminal) return;
    window.terminal.term.paste(t);
    window.terminal.focus();
    setTimeout(() => window.api.term.write('\r'), 150);
  });

  // --- аватар (этап 2); не валим приложение, если VRM не загрузилась ---
  try {
    // index.html лежит в src/renderer/ → корень проекта на 2 уровня выше
    const vrmUrl = new URL(`../../${config.avatar.vrmPath}`, window.location.href).href;
    window.avatar = await initAvatar(avatarPane, { ...config.avatar, vrmUrl });
  } catch (err) {
    console.error('[avatar] не удалось инициализировать:', err);
  }

  // ---------------------------------------------------------------
  // Единая функция управления видимостью панели аватара + сплиттера
  // ---------------------------------------------------------------
  function setAvatarVisible(v) {
    if (v) {
      avatarPane.classList.remove('hidden');
      splitter.classList.remove('hidden');
    } else {
      avatarPane.classList.add('hidden');
      splitter.classList.add('hidden');
    }
    window.avatar?.setVisible(v);
  }

  // Применяем стартовое состояние из конфига
  if (config.avatar.visible === false) {
    setAvatarVisible(false);
  }

  // ---------------------------------------------------------------
  // Сплиттер — drag для изменения ширины панели аватара
  // ---------------------------------------------------------------
  let dragging = false;
  let currentWidthPercent = config.avatar.widthPercent ?? 36;

  function applyWidth(p) {
    currentWidthPercent = Math.min(60, Math.max(20, p));
    avatarPane.style.flexBasis = currentWidthPercent + '%';
  }

  splitter.addEventListener('pointerdown', (e) => {
    dragging = true;
    splitter.setPointerCapture(e.pointerId);
    splitter.classList.add('dragging');
    e.preventDefault();
  });

  splitter.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const rect  = appEl.getBoundingClientRect();
    let p;
    if (side === 'left') {
      // flex-direction: row-reverse — аватар слева, перетаскиваем правый край аватара
      p = (e.clientX - rect.left) / rect.width * 100;
    } else {
      // flex-direction: row — аватар справа, ширина = правый край минус курсор
      p = (rect.right - e.clientX) / rect.width * 100;
    }
    applyWidth(p);
  });

  splitter.addEventListener('pointerup', (e) => {
    if (!dragging) return;
    dragging = false;
    splitter.releasePointerCapture(e.pointerId);
    splitter.classList.remove('dragging');
    window.api.config.set({ avatar: { widthPercent: Math.round(currentWidthPercent) } });
  });

  splitter.addEventListener('dblclick', () => {
    applyWidth(36);
    window.api.config.set({ avatar: { widthPercent: 36 } });
  });

  // ---------------------------------------------------------------
  // F9 — переключение видимости аватара
  // ---------------------------------------------------------------
  // capture-фаза обязательна: при фокусе в терминале xterm гасит всплытие
  // F-клавиш, и без capture событие до window не доходит (F7 — так же).
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'F9' && e.code !== 'F9') return;
    e.preventDefault();
    const visible = avatarPane.classList.contains('hidden');
    setAvatarVisible(visible);
    window.terminal?.focus();
    window.api.config.set({ avatar: { visible } });
  }, true);

  // ---------------------------------------------------------------
  // TTS воспроизведение (VoiceOut)
  // ---------------------------------------------------------------

  // --- Субтитры ---
  const subtitlesEl = $('subtitles');
  let subtitlesHideTimer = null;

  function showSubtitles(text) {
    if (!subtitlesEl) return;
    if (subtitlesHideTimer) { clearTimeout(subtitlesHideTimer); subtitlesHideTimer = null; }
    subtitlesEl.textContent = text || '';
    subtitlesEl.classList.toggle('visible', !!text);
  }

  function hideSubtitlesDelayed() {
    if (!subtitlesEl) return;
    subtitlesHideTimer = setTimeout(() => {
      subtitlesEl.classList.remove('visible');
      subtitlesHideTimer = null;
    }, 1500);
  }

  // --- Индикатор голоса ---
  const voiceDotEl = $('voice-dot');

  function setVoiceDot(state) {
    if (!voiceDotEl) return;
    voiceDotEl.classList.remove('rec', 'listen', 'speak');
    if (state) voiceDotEl.classList.add(state);
  }

  // --- Мут-состояние в статусе ---
  let _mutePrefixActive = false;

  function updateTtsStatus(text) {
    const el = $('status-tts');
    if (!el) return;
    if (_mutePrefixActive) {
      // мут активен — показываем значок, но сохраняем суть статуса
      el.textContent = '🔇 ' + text.replace(/^🔊\s*/, '');
    } else {
      el.textContent = text;
    }
  }

  // Стартовая громкость из конфига (дефолт 0.9)
  const initVolume = config.tts?.volume ?? 0.9;

  const voiceOut = new VoiceOut({
    getLipsync:  () => window.avatar?.lipsync ?? null,
    onStatus:    (t) => {
      updateTtsStatus(t);
      // Когда очередь закончилась — убрать субтитры с задержкой и точку,
      // спрятать кнопку «стоп»; пока говорит — показать её.
      const speakingNow = t !== '🔊 —';
      $('status-stop')?.classList.toggle('on', speakingNow);
      if (!speakingNow) {
        hideSubtitlesDelayed();
        setVoiceDot(null);
        window.avatar?.setEmotion('neutral', 1); // лицо обратно в нейтраль
      } else {
        setVoiceDot('speak');
      }
    },
    onUtterance: (text, emotion) => {
      showSubtitles(text);
      // Панель аватара скрыта — субтитров не видно; дублируем реплику в
      // статус-бар. Обычный статус вернёт onStatus по завершении очереди.
      if (avatarPane.classList.contains('hidden') && text) {
        const cut = text.slice(0, 70) + (text.length > 70 ? '…' : '');
        $('status-tts').textContent = '🔊 ' + cut;
      }
      // Выражение лица в тон ответа; сбрасывается в neutral после речи.
      if (emotion && emotion !== 'neutral') window.avatar?.setEmotion(emotion, 0.7);
    },
  });
  voiceOut.setVolume(initVolume);
  window.voiceOut = voiceOut;

  window.api.tts?.onSpeak?.(({ wav, text, emotion }) => {
    if (config.tts?.enabled !== false) voiceOut.enqueue(wav, text ?? '', emotion ?? 'neutral');
  });

  // Кнопка ⏹ — остановить текущую озвучку
  $('status-stop')?.addEventListener('click', () => voiceOut.stopAll());

  // Клик по #status-tts — переключить мут
  $('status-tts')?.addEventListener('click', () => {
    const nowMuted = voiceOut.toggleMute();
    _mutePrefixActive = nowMuted;
    // обновляем отображение текущего статусного текста
    updateTtsStatus(voiceOut.speaking ? '🔊 говорю…' : '🔊 —');
  });

  // Ctrl+wheel над #avatar-pane — регулировка громкости ±5%
  let _volumeDisplayTimer = null;
  avatarPane.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const delta = e.deltaY < 0 ? 0.05 : -0.05;
    voiceOut.setVolume(voiceOut.volume + delta);
    _mutePrefixActive = false; // setVolume снимает мут
    const pct = Math.round(voiceOut.volume * 100);
    const el = $('status-tts');
    if (el) el.textContent = `🔊 ${pct}%`;
    if (_volumeDisplayTimer) clearTimeout(_volumeDisplayTimer);
    _volumeDisplayTimer = setTimeout(() => {
      updateTtsStatus('🔊 —');
      _volumeDisplayTimer = null;
    }, 1500);
    // Debounce 500 мс для записи в конфиг
    if (avatarPane._volSaveTimer) clearTimeout(avatarPane._volSaveTimer);
    avatarPane._volSaveTimer = setTimeout(() => {
      window.api.config.set({ tts: { volume: voiceOut.volume } });
      avatarPane._volSaveTimer = null;
    }, 500);
  }, { passive: false });

  // Закрытие окна с несохранённой громкостью: debounce мог не успеть —
  // сбрасываем значение немедленно, чтобы настройка не потерялась.
  window.addEventListener('beforeunload', () => {
    if (avatarPane._volSaveTimer) {
      clearTimeout(avatarPane._volSaveTimer);
      avatarPane._volSaveTimer = null;
      window.api.config.set({ tts: { volume: voiceOut.volume } });
    }
  });

  // Ctrl+Shift+S — остановить речь
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'S') {
      e.preventDefault();
      voiceOut.stopAll();
    }
  }, true);

  // ---------------------------------------------------------------
  // Голосовой ввод (STT): режимы push-to-talk и wake-word ("как Сири")
  // ---------------------------------------------------------------
  try {
    const recorder   = new VoiceRecorder();
    const sttKey     = config.stt?.hotkey ?? 'ShiftRight';
    const autoSubmit = config.stt?.autoSubmit !== false;
    const statusEl   = $('status-stt');
    let   sttBusy    = false; // во время transcribe не стартуем новую запись

    // Режим голосового ввода: 'push' (правый Shift) | 'wake' (по имени).
    const sttMode = { value: config.stt?.mode ?? 'push' };

    // Wake-слова / sleep-слова из конфига.
    const wakeWords  = (config.stt?.wakeWords  ?? ['юки']).map(normWord);
    const sleepWords = (config.stt?.sleepWords ?? ['спи', 'усни', 'отключись']).map(normWord);

    // Хоткей задаётся как e.code ('ShiftRight', 'F8') или e.key ('F8').
    const isSttKey = (e) => e.code === sttKey || e.key === sttKey;

    function setSttStatus(text) {
      if (statusEl) statusEl.textContent = text;
      // Обновляем индикатор голоса по тексту статуса
      if (text === '🎤 запись…') {
        setVoiceDot('rec');
        avatarPane.classList.add('recording');
      } else {
        avatarPane.classList.remove('recording');
        if (!voiceOut.speaking) setVoiceDot(null);
      }
    }

    // Статус покоя зависит от режима.
    function idleStatus() {
      return sttMode.value === 'wake' ? '🎤 имя' : '🎤 shift';
    }
    function resetIdleStatus() {
      setSttStatus(idleStatus());
      // В wake-режиме покоя — точка «listen»; в push — без класса
      if (sttMode.value === 'wake') {
        setVoiceDot('listen');
      } else {
        if (!voiceOut.speaking) setVoiceDot(null);
      }
    }

    // Нормализация распознанного текста: lowercase, ё→е, без пунктуации.
    // Греческие омоглифы — в кириллицу: whisper иногда выдаёт «ιοκи»
    // вместо «йоки», и матчинг по Левенштейну слепнет.
    const GREEK = { 'ι': 'и', 'ο': 'о', 'κ': 'к', 'α': 'а', 'ε': 'е', 'η': 'н', 'υ': 'у', 'ρ': 'р', 'χ': 'х', 'τ': 'т', 'ν': 'в', 'μ': 'м' };
    function normWord(s) {
      return String(s)
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/[ιοκαεηυρχτνμ]/g, (ch) => GREEK[ch])
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    // Короткий beep через Web Audio (up: 880Гц, down: 440Гц).
    let beepCtx = null;
    function beep(up) {
      try {
        beepCtx = beepCtx ?? new AudioContext();
        const osc  = beepCtx.createOscillator();
        const gain = beepCtx.createGain();
        osc.frequency.value = up ? 880 : 440;
        gain.gain.value = 0.2;
        osc.connect(gain);
        gain.connect(beepCtx.destination);
        osc.start();
        osc.stop(beepCtx.currentTime + 0.12);
      } catch (_) {}
    }

    // Вставка текста в терминал + (опционально) Enter.
    function submit(text) {
      const t = text.trim();
      if (!t) return;
      window.terminal.term.paste(t);
      window.terminal.focus();
      if (autoSubmit) setTimeout(() => window.api.term.write('\r'), 150);
      setSttStatus('🎤 готово');
      setTimeout(resetIdleStatus, 3000);
    }

    resetIdleStatus();

    // ---- push-to-talk (правый Shift) — работает в обоих режимах ----
    // Общая логика старта/остановки записи: используется и локальными
    // window-обработчиками ShiftRight, и глобальным хуком (ptt-down/ptt-up).

    // Старт записи (зажали правый Shift). Хук сам фильтрует автоповтор.
    async function pttDown() {
      if (recorder.recording || sttBusy) return;
      try {
        // Новая задача голосом = прежнюю озвучку глушим.
        window.voiceOut?.stopAll();
        // Сбрасываем wake-ожидание: иначе режим «слушаю…» отправит команду
        // вторым submit'ом (clearAwaiting объявлен ниже — function-hoisting).
        clearAwaiting();
        await recorder.start();
        setSttStatus('🎤 запись…');
      } catch (err) {
        console.warn('[stt] start error:', err);
        setSttStatus('🎤 ошибка');
      }
    }

    // Остановка записи (отпустили правый Shift) → распознать → submit/idle.
    async function pttUp() {
      if (!recorder.recording || sttBusy) return;
      setSttStatus('🎤 распознаю…');
      sttBusy = true;
      try {
        const wav = await recorder.stop();
        if (!wav) {
          resetIdleStatus();
          return;
        }
        const text = await window.api.stt.transcribe(wav);
        if (text && text.trim()) {
          submit(text);
        } else {
          resetIdleStatus();
        }
      } catch (err) {
        console.warn('[stt] transcribe error:', err);
        setSttStatus('🎤 ошибка');
      } finally {
        sttBusy = false;
      }
    }

    // Активен ли глобальный низкоуровневый хук (покрывает и сфокусированное
    // окно). Пока он жив — локальные ShiftRight-обработчики уступают ему,
    // чтобы запись не стартовала дважды.
    let globalHookActive = false;
    window.api.stt?.onPttHook?.(({ active }) => { globalHookActive = active; });
    window.api.stt?.onPttDown?.(() => { pttDown(); });
    window.api.stt?.onPttUp?.(() => { pttUp(); });

    window.addEventListener('keydown', (e) => {
      if (!isSttKey(e)) return;
      // Не реагируем в составе комбинаций (Ctrl+Shift+C и т.п.)
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      e.preventDefault();
      if (globalHookActive) return; // глобальный хук уже покрывает это окно
      if (e.repeat) return;
      pttDown();
    }, true);

    window.addEventListener('keyup', (e) => {
      if (!isSttKey(e)) return;
      e.preventDefault();
      if (globalHookActive) return; // глобальный хук уже покрывает это окно
      pttUp();
    }, true);

    // ---- глобальная клавиша записи (toggle, работает без фокуса окна) ----
    // Первое нажатие — старт записи (восходящий бип), второе — распознать
    // и отправить (нисходящий бип). Регистрируется в main через globalShortcut.
    window.api.stt?.onPttToggle?.(async () => {
      if (sttBusy) return;
      if (!recorder.recording) {
        try {
          window.voiceOut?.stopAll(); // новая задача — прежнюю озвучку глушим
          await recorder.start();
          beep(true);
          setSttStatus('🎤 запись…');
        } catch (err) {
          console.warn('[stt] global start error:', err);
          setSttStatus('🎤 ошибка');
        }
        return;
      }
      beep(false);
      setSttStatus('🎤 распознаю…');
      sttBusy = true;
      try {
        const wav = await recorder.stop();
        if (!wav) { resetIdleStatus(); return; }
        const text = await window.api.stt.transcribe(wav);
        if (text && text.trim()) submit(text);
        else resetIdleStatus();
      } catch (err) {
        console.warn('[stt] global transcribe error:', err);
        setSttStatus('🎤 ошибка');
      } finally {
        sttBusy = false;
      }
    });

    // ---- wake-word режим ----
    let awaitingCommand = false;
    let awaitingTimer   = null;
    let wakeBusy        = false; // guard от параллельных распознаваний сегментов

    function clearAwaiting() {
      awaitingCommand = false;
      if (awaitingTimer) { clearTimeout(awaitingTimer); awaitingTimer = null; }
    }

    // «Бип» + окно ожидания команды на 8 секунд.
    function startAwaiting() {
      awaitingCommand = true;
      if (awaitingTimer) clearTimeout(awaitingTimer);
      awaitingTimer = setTimeout(() => {
        awaitingCommand = false;
        awaitingTimer = null;
        resetIdleStatus();
      }, 8000);
      setSttStatus('🎤 слушаю…');
      beep(true);
    }

    // Расстояние Левенштейна (для нечёткого матчинга имени: «уки», «юкки»).
    function lev(a, b) {
      if (Math.abs(a.length - b.length) > 2) return 99;
      const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
      for (let j = 1; j <= b.length; j++) dp[0][j] = j;
      for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
          dp[i][j] = Math.min(
            dp[i - 1][j] + 1,
            dp[i][j - 1] + 1,
            dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
          );
        }
      }
      return dp[a.length][b.length];
    }

    const isWakeToken = (tok) => wakeWords.some((w) => w && (tok === w || lev(tok, w) <= 1));

    // Поиск wake-слова В ЛЮБОМ месте сегмента (нечёткое): при фоновом
    // звуке (видео/музыка) VAD клеит речь пользователя к чужой — имя
    // оказывается в середине куска. Возвращает текст ПОСЛЕ имени.
    // null — имя не прозвучало.
    function matchWake(text) {
      const tokens = text.split(' ');
      for (let i = 0; i < tokens.length; i++) {
        if (isWakeToken(tokens[i])) return tokens.slice(i + 1).join(' ').trim();
        // whisper мог разбить имя на два токена («ю ки»)
        if (i + 1 < tokens.length && isWakeToken(tokens[i] + tokens[i + 1])) {
          return tokens.slice(i + 2).join(' ').trim();
        }
      }
      return null;
    }

    // Позиционно-сохраняющая нормализация (lowercase + ё→е + греческие
    // омоглифы — все 1:1 по символам, индексы не сдвигаются). По
    // нормализованному слову находим место в СЫРОМ тексте.
    function lightNorm(s) {
      return String(s).toLowerCase().replace(/ё/g, 'е')
        .replace(/[ιοκαεηυρχτνμ]/g, (ch) => GREEK[ch] || ch);
    }
    // Красивый текст команды: raw начиная с первого слова нормализованного
    // остатка — сохраняет регистр, «ё» и пунктуацию (как у push-to-talk).
    function rawCommand(raw, normRest) {
      const fw = (normRest || '').split(' ')[0];
      if (!fw) return '';
      const idx = lightNorm(raw).indexOf(fw);
      return idx >= 0 ? raw.slice(idx).trim() : (normRest || '');
    }

    // Известные «галлюцинации» whisper на шуме/тишине — игнорировать всегда.
    const JUNK = ['субтитр', 'продолжение следует', 'дима торзок', 'dimatorzok',
      'редактор', 'корректор', 'спасибо за просмотр', 'до встречи'];
    const isJunk = (text) => JUNK.some((j) => text.includes(j));

    function containsSleep(text) {
      return sleepWords.some((w) => w && (text === w || text.includes(w + ' ') || text.startsWith(w + ' ') || text.split(' ').includes(w)));
    }

    const wakeListener = new WakeListener({
      vadThreshold: config.stt?.vadThreshold,
      silenceMs:    config.stt?.silenceMs,
      maxSegmentMs: config.stt?.maxSegmentMs,
      minSegmentMs: config.stt?.minSegmentMs,
      preRollMs:    config.stt?.preRollMs,
      onSegment: async (wav) => {
        if (wakeBusy) return;
        wakeBusy = true;
        try {
          setSttStatus('🎤 …');
          const raw = await window.api.stt.transcribe(wav);
          const text = normWord(raw ?? '');
          // Отладка wake-распознавания: видно в stdout приложения.
          if (config.stt?.debug !== false) console.error(`[wake-text] "${raw}" -> "${text}"`);
          if (!text || isJunk(text)) { if (!awaitingCommand) resetIdleStatus(); return; }

          // Пока говорит TTS — реагируем ТОЛЬКО на имя: оно останавливает
          // озвучку («стоп-сигнал»), дальше обычный сценарий wake.
          if (window.voiceOut?.speaking) {
            const rest = matchWake(text);
            if (rest === null) { if (!awaitingCommand) resetIdleStatus(); return; }
            window.voiceOut.stopAll();
            if (containsSleep(rest)) { beep(false); switchMode('push'); return; }
            if (rest) { submit(rawCommand(raw, rest)); } else { startAwaiting(); }
            return;
          }

          // a) ждём команду — весь текст это команда (отправляем сырой).
          if (awaitingCommand) {
            clearAwaiting();
            submit((raw ?? '').trim());
            return;
          }

          // b) текст начинается с wake-слова.
          const rest = matchWake(text);
          if (rest !== null) {
            if (containsSleep(rest)) {
              // переключение в push-режим
              beep(false);
              switchMode('push');
              return;
            }
            if (rest) {
              submit(rawCommand(raw, rest));
            } else {
              startAwaiting(); // только имя — ждём команду после сигнала
            }
            return;
          }

          // c) текст без wake-слова — игнор.
          resetIdleStatus();
        } catch (err) {
          console.warn('[wake] segment error:', err);
        } finally {
          wakeBusy = false;
        }
      },
    });
    window.wakeListener = wakeListener;

    // Переключение режима с персистом и обновлением статуса.
    async function switchMode(mode) {
      sttMode.value = mode;
      clearAwaiting();
      window.api.config.set({ stt: { mode } });
      if (mode === 'wake') {
        try {
          await wakeListener.start();
        } catch (err) {
          console.warn('[wake] start error, остаёмся в push:', err);
          sttMode.value = 'push';
          window.api.config.set({ stt: { mode: 'push' } });
          setSttStatus('🎤 ошибка');
          setTimeout(resetIdleStatus, 2000);
          return;
        }
      } else {
        await wakeListener.stop();
      }
      resetIdleStatus();
    }

    // F7 — переключение режима push↔wake.
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'F7' && e.code !== 'F7') return;
      e.preventDefault();
      const next = sttMode.value === 'wake' ? 'push' : 'wake';
      console.error(`[mode] F7 → ${next}`); // отладка: видно в stdout приложения
      switchMode(next);
    }, true);

    // Во время TTS слушатель НЕ ставим на паузу: имя должно работать как
    // «стоп-сигнал». Эхо собственного голоса давит echoCancellation (AEC
    // гасит звук, который воспроизводит этот же renderer), а сегменты без
    // имени в это время игнорируются в onSegment.

    // Автостарт wake-режима из конфига.
    if (sttMode.value === 'wake') {
      wakeListener.start().catch((err) => {
        console.warn('[wake] автостарт не удался, остаёмся в push:', err);
        sttMode.value = 'push';
        resetIdleStatus();
      });
    }
  } catch (err) {
    console.warn('[stt] голосовой ввод недоступен:', err);
  }
}

main();
