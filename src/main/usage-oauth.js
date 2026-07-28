'use strict';
// Поллер официальных лимитов Claude (5-часовое/недельное окно) через OAuth
// usage-эндпоинт. Модуль ЧИСТЫЙ: сеть/файлы/токен — только через инжектируемые
// readToken/httpGet/cache/now/log. Токен никогда не логируется и не попадает
// в снапшот/кэш — наружу (в renderer) уходят только проценты и метки времени.

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const DEFAULT_USER_AGENT_VERSION = '2.1.220';
const AUTH_BACKOFF_MS = 15 * 60 * 1000; // 401/403 — токен могли обновить, не долбим лимит запросов
const RATE_BACKOFF_MS = 10 * 60 * 1000; // 429 — сервер прямо просит подождать

// Маска на случай, если в тексте чужой ошибки (httpGet/net) окажется
// какой-то токен, похожий на наш формат, — защита в глубину сверх точного
// вырезания известного значения ниже.
const TOKEN_LIKE_RE = /sk-ant-[A-Za-z0-9_-]+/g;

// Вырезает из текста ЛЮБЫЕ вхождения известного токена (если он передан) и
// любую подстроку, похожую на токен по формату. Применяется ко ВСЕМ
// сообщениям перед логированием — токен не должен просочиться, даже если
// он попал в текст стороннего err.message (например, если реализация
// httpGet echo'ит заголовки запроса в исключении).
function sanitizeForLog(text, token) {
  let out = String(text);
  if (token) out = out.split(token).join('***');
  return out.replace(TOKEN_LIKE_RE, '***');
}

function emptyPart() {
  return { percent: 0, resetsAt: null };
}

function zeroSnapshot() {
  return {
    ok: false,
    stale: false,
    fetchedAt: 0,
    fiveHour: emptyPart(),
    sevenDay: emptyPart(),
    scoped: [],
    error: null,
  };
}

// ISO-строка → ms (Date.parse); отсутствующее/невалидное значение → null, не бросаем.
function toMs(iso) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

function toPart(raw) {
  return { percent: Number(raw && raw.utilization) || 0, resetsAt: toMs(raw && raw.resets_at) };
}

// limits[] → scoped[]: только kind=weekly_scoped с непустым scope.model.display_name.
function toScoped(limits) {
  const out = [];
  for (const lim of Array.isArray(limits) ? limits : []) {
    if (!lim || lim.kind !== 'weekly_scoped') continue;
    const label = lim.scope && lim.scope.model && lim.scope.model.display_name;
    if (!label) continue; // без имени модели запись бесполезна для UI — пропускаем
    out.push({ label, percent: Number(lim.percent) || 0, resetsAt: toMs(lim.resets_at) });
  }
  return out;
}

function parseBody(body) {
  return {
    fiveHour: toPart(body && body.five_hour),
    sevenDay: toPart(body && body.seven_day),
    scoped: toScoped(body && body.limits),
  };
}

// Кэш валиден, только если percent у обеих частей реально числа — не просто
// «поле присутствует» (при смене схемы кэша на диске легко словить
// percent:undefined, который иначе тихо просочился бы в снапшот как валидный).
function isGoodCacheShape(c) {
  return !!c
    && c.fiveHour && typeof c.fiveHour.percent === 'number'
    && c.sevenDay && typeof c.sevenDay.percent === 'number';
}

function createUsagePoller({
  readToken,
  httpGet,
  cache,
  now = Date.now,
  intervalMs = 180000,
  userAgentVersion = DEFAULT_USER_AGENT_VERSION,
  log = () => {},
}) {
  let state = zeroSnapshot();
  let haveGood = false; // получали ли реальные данные — живьём в эту сессию или из кэша
  let lastGood = null; // { fiveHour, sevenDay, scoped, fetchedAt }
  let currentIntervalMs = intervalMs; // рабочий интервал автопоследовательности (растёт при 401/429)
  let nextAllowedAt = 0; // now() раньше которого refresh() не бьёт по сети (жёсткий гейт 429)
  let started = false;
  let timer = null;
  let currentToken = null; // accessToken текущего refresh() — только для санитайзинга log, никуда больше не уходит

  // Обёртка над инжектированным log: вырезает токен из ЛЮБОГО сообщения.
  // Используется вместо «сырого» log везде, а не только в местах, где мы
  // сами формируем текст, — на случай, если токен просочился в чужой
  // err.message (см. FINDING 1 ревью).
  function safeLog(msg) {
    log(sanitizeForLog(msg, currentToken));
  }

  function applyGood(parsed, fetchedAt) {
    lastGood = { ...parsed, fetchedAt };
    haveGood = true;
    state = {
      ok: true, stale: false, fetchedAt,
      fiveHour: parsed.fiveHour, sevenDay: parsed.sevenDay, scoped: parsed.scoped,
      error: null,
    };
    try {
      cache.write(lastGood);
    } catch (err) {
      safeLog(`[usage-oauth] cache.write упал: ${err.message}`);
    }
  }

  function applyError(kind) {
    if (!haveGood) {
      let cached = null;
      try {
        cached = cache.read();
      } catch (err) {
        safeLog(`[usage-oauth] cache.read упал: ${err.message}`);
      }
      if (isGoodCacheShape(cached)) {
        lastGood = cached;
        haveGood = true;
      }
    }
    if (haveGood) {
      state = {
        ok: true, stale: true, fetchedAt: lastGood.fetchedAt,
        fiveHour: lastGood.fiveHour, sevenDay: lastGood.sevenDay, scoped: lastGood.scoped || [],
        error: kind,
      };
    } else {
      state = { ...zeroSnapshot(), error: kind };
    }
  }

  async function refresh() {
    // 429-бэкофф — жёсткий гейт: не долбим сервер раньше времени, ни таймером, ни руками.
    if (now() < nextAllowedAt) return state;

    const token = readToken ? readToken() : null;
    currentToken = token && token.accessToken ? token.accessToken : null;
    if (!token || !token.accessToken) {
      applyError('auth');
      currentIntervalMs = AUTH_BACKOFF_MS;
      return state;
    }

    let res;
    try {
      res = await httpGet(USAGE_URL, {
        Authorization: `Bearer ${token.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': `claude-code/${userAgentVersion}`,
      });
    } catch (err) {
      safeLog(`[usage-oauth] сетевой сбой: ${err.message}`);
      applyError('network');
      currentIntervalMs = intervalMs;
      return state;
    }

    if (res.status === 401 || res.status === 403) {
      applyError('auth');
      currentIntervalMs = AUTH_BACKOFF_MS;
      return state;
    }
    if (res.status === 429) {
      applyError('rate');
      nextAllowedAt = now() + RATE_BACKOFF_MS;
      currentIntervalMs = RATE_BACKOFF_MS;
      return state;
    }
    if (res.status !== 200) {
      applyError('network');
      currentIntervalMs = intervalMs;
      return state;
    }

    let parsed;
    try {
      const body = typeof res.body === 'string' ? JSON.parse(res.body) : res.body;
      parsed = parseBody(body);
    } catch (err) {
      safeLog(`[usage-oauth] не удалось разобрать ответ: ${err.message}`);
      applyError('network');
      currentIntervalMs = intervalMs;
      return state;
    }

    applyGood(parsed, now());
    currentIntervalMs = intervalMs;
    return state;
  }

  function scheduleNext() {
    timer = setTimeout(tick, currentIntervalMs);
    if (timer.unref) timer.unref();
  }

  function tick() {
    timer = null;
    refresh().finally(() => {
      if (started) scheduleNext();
    });
  }

  // Немедленный первый запрос + дальше по расписанию (с бэкоффом при ошибках).
  function start() {
    if (started) return; // повторный вызов — no-op, таймер не плодим
    started = true;
    tick();
  }

  function stop() {
    started = false;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function snapshot() {
    return {
      ...state,
      fiveHour: { ...state.fiveHour },
      sevenDay: { ...state.sevenDay },
      scoped: state.scoped.map((s) => ({ ...s })),
    };
  }

  return { start, stop, snapshot, refresh };
}

module.exports = { createUsagePoller };
