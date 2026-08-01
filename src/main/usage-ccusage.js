'use strict';
// Слой расходов ccusage (по проектам/дням/моделям). Модуль ЧИСТЫЙ: процесс
// (`run`), кэш (`cache`) и время (`now`) — только инжектируются. Никакого
// electron и никакого child_process здесь: в проде run(args) будет
// execFile('npx', ['--yes', CCUSAGE_PACKAGE, ...args]) с таймаутом 60с —
// это делает проводка вне этого модуля (константа версии — в ipc.js, рядом
// с самим раннером, задача 5 фазы 6: версия запинена на 20.0.19, не @latest).
//
// Фактические команды (зафиксировано в отчёте задачи; версия пакета с тех
// пор запинена — см. CCUSAGE_PACKAGE в ipc.js, — набор аргументов не менялся):
//   npx --yes ccusage@X.Y.Z claude daily --json    → byDay + byModel + totals
//   npx --yes ccusage@X.Y.Z claude session --json  → byProject + totals.sessions
// Оба вызова идут параллельно через Promise.all — каждый npx стоит секунды.
//
// Правило деградации: run бросил / code!=0 / вывод не парсится →
// ok:false, error:'unavailable'|'parse'; если есть кэш — отдаём его со
// stale:true. Никогда не бросаем наружу.

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function roundInt(n) {
  return Math.round(Number(n) || 0);
}

function safeArray(a) {
  return Array.isArray(a) ? a : [];
}

// ISO-строка → ms (Date.parse); отсутствующее/невалидное значение → null, не бросаем.
function toMs(iso) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

// Токены отдельной строки modelBreakdowns: у ccusage там нет готового
// totalTokens — считаем сами (проверено на реальном образце: совпадает с
// totalTokens дня/сессии).
function modelTokens(m) {
  return (Number(m.cacheCreationTokens) || 0)
    + (Number(m.cacheReadTokens) || 0)
    + (Number(m.inputTokens) || 0)
    + (Number(m.outputTokens) || 0);
}

function emptyData() {
  return {
    totals: { costUsd: 0, tokens: 0, sessions: 0 },
    byProject: [],
    byDay: [],
    byModel: [],
  };
}

// Кэш валиден, только если форма реально совпадает — не просто «поле есть»
// (защита от смены схемы кэша на диске между версиями модуля).
function isGoodCacheShape(c) {
  return !!c
    && typeof c.fetchedAt === 'number'
    && c.totals && typeof c.totals.costUsd === 'number' && typeof c.totals.tokens === 'number' && typeof c.totals.sessions === 'number'
    && Array.isArray(c.byProject)
    && Array.isArray(c.byDay)
    && Array.isArray(c.byModel);
}

function normalize(dailyBody, sessionBody) {
  const days = safeArray(dailyBody && dailyBody.daily);
  const totalsRaw = (dailyBody && dailyBody.totals) || {};
  const sessions = safeArray(sessionBody && sessionBody.sessions);

  // byDay: последние 30 дней по возрастанию даты. Сортируем сами явно —
  // не полагаемся на порядок, в котором ccusage отдал массив.
  const byDayAll = days
    .filter((d) => d && d.date)
    .map((d) => ({ date: d.date, costUsd: round2(d.totalCost), tokens: roundInt(d.totalTokens) }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const byDay = byDayAll.slice(-30);

  // byModel: агрегируем modelBreakdowns по всем дням из ответа.
  const modelMap = new Map();
  for (const day of days) {
    for (const m of safeArray(day && day.modelBreakdowns)) {
      if (!m || !m.modelName) continue;
      const prev = modelMap.get(m.modelName) || { costUsd: 0, tokens: 0 };
      prev.costUsd += Number(m.cost) || 0;
      prev.tokens += modelTokens(m);
      modelMap.set(m.modelName, prev);
    }
  }
  const byModel = [...modelMap.entries()]
    .map(([model, v]) => ({ model, costUsd: round2(v.costUsd), tokens: roundInt(v.tokens) }))
    .sort((a, b) => b.costUsd - a.costUsd);

  // byProject: агрегируем сессии по projectPath; lastActive = максимум lastActivity.
  const projMap = new Map();
  for (const s of sessions) {
    if (!s || !s.projectPath) continue;
    const prev = projMap.get(s.projectPath) || { costUsd: 0, tokens: 0, lastActive: null };
    prev.costUsd += Number(s.totalCost) || 0;
    prev.tokens += Number(s.totalTokens) || 0;
    const la = toMs(s.lastActivity);
    if (la !== null && (prev.lastActive === null || la > prev.lastActive)) prev.lastActive = la;
    projMap.set(s.projectPath, prev);
  }
  const byProject = [...projMap.entries()]
    .map(([name, v]) => ({ name, costUsd: round2(v.costUsd), tokens: roundInt(v.tokens), lastActive: v.lastActive }))
    .sort((a, b) => b.costUsd - a.costUsd);

  const totals = {
    costUsd: round2(totalsRaw.totalCost),
    tokens: roundInt(totalsRaw.totalTokens),
    sessions: sessions.length,
  };

  return { totals, byProject, byDay, byModel };
}

function createCcusage({ run, cache, now = Date.now, ttlMs = 600000 }) {
  let lastGood = null; // { totals, byProject, byDay, byModel, fetchedAt }
  let loadedFromDisk = false;
  // Задача 5 фазы 6 (carryover, single-flight get()): ipc.js защищает от
  // параллельных usage:refresh (manualRefreshInFlight), но usage:get() и
  // usage:refresh — РАЗНЫЕ IPC-каналы, и ничто снаружи не мешало им обоим
  // одновременно дёрнуть ccusage.get() (один — ленивый usage:get при открытии
  // дашборда, другой — usage:refresh по клику «Обновить») — до ЧЕТЫРЁХ
  // параллельных npx (daily+session от каждого). inFlight — промис ТЕКУЩЕГО
  // выполняющегося get(), пока он не разрешится: любой ДРУГОЙ вызов get(),
  // пришедший, пока inFlight ещё не null, получает ЭТОТ ЖЕ промис (тот же
  // объект — второй fetchFresh() не запускается вовсе), а не свой отдельный.
  let inFlight = null;

  // Читаем дисковый кэш лениво один раз за жизнь инстанса — дальше доверяем
  // накопленному в памяти lastGood (аналог usage-oauth).
  function ensureLoadedFromCache() {
    if (loadedFromDisk) return;
    loadedFromDisk = true;
    let cached = null;
    try {
      cached = cache.read();
    } catch (err) {
      // диск недоступен/битый — просто нет кэша, не бросаем.
    }
    if (isGoodCacheShape(cached)) lastGood = cached;
  }

  function buildResult(okFlag, stale, data, fetchedAt, error) {
    return {
      ok: okFlag,
      stale,
      fetchedAt: data ? fetchedAt : 0,
      error: error || null,
      totals: data ? { ...data.totals } : emptyData().totals,
      byProject: data ? data.byProject.map((p) => ({ ...p })) : [],
      byDay: data ? data.byDay.map((d) => ({ ...d })) : [],
      byModel: data ? data.byModel.map((m) => ({ ...m })) : [],
    };
  }

  function applyError(kind) {
    if (lastGood) {
      return buildResult(true, true, lastGood, lastGood.fetchedAt, kind);
    }
    return buildResult(false, false, null, 0, kind);
  }

  // Инцидент «зависает вместе с компом» (01.08, машина с 8ГБ ОЗУ, своп до
  // 14.6ГБ). Замеры ревью на реальном хранилище (1.7ГБ транскриптов):
  //   daily --json                              9.3с, пик RSS 594МБ
  //   daily --json --since <окно>               7.6с, пик RSS 595МБ (!)
  //   daily --json --offline --single-thread   ~7.6с, пик RSS 240МБ
  // Вывод: --since НЕ экономит память вовсе (ccusage читает все JSONL и
  // режет только агрегацию — проверено окном в 1 день: та же память), зато
  // молча превращал карточки «(всего)» дашборда в оконные (терялось 23.5%
  // аккаунта). Поэтому НИКАКОГО --since. Настоящие рычаги:
  //   --offline       прайсинг из локального кэша ccusage, без сети;
  //   --single-thread последовательная загрузка JSONL — пик двух
  //                   параллельных прогонов падает с ~1.1ГБ до ~485МБ,
  //                   на 8ГБ-машине это разница «тормозит»/«висит намертво».
  async function fetchFresh() {
    let dailyRes;
    let sessionRes;
    try {
      [dailyRes, sessionRes] = await Promise.all([
        run(['claude', 'daily', '--json', '--offline', '--single-thread']),
        run(['claude', 'session', '--json', '--offline', '--single-thread']),
      ]);
    } catch (err) {
      return { kind: 'unavailable' };
    }
    if (!dailyRes || dailyRes.code !== 0 || !sessionRes || sessionRes.code !== 0) {
      return { kind: 'unavailable' };
    }

    let dailyBody;
    let sessionBody;
    try {
      dailyBody = JSON.parse(dailyRes.stdout);
      sessionBody = JSON.parse(sessionRes.stdout);
    } catch (err) {
      return { kind: 'parse' };
    }

    return { kind: null, data: normalize(dailyBody, sessionBody) };
  }

  async function doGet({ force = false, cacheOnly = false } = {}) {
    ensureLoadedFromCache();

    const nowMs = now();
    if (!force && lastGood && (nowMs - lastGood.fetchedAt) < ttlMs) {
      return buildResult(true, false, lastGood, lastGood.fetchedAt, null);
    }

    // Инцидент 8ГБ: стартовое окно кокпита (первые ~90с — шторм спавна
    // сессий) не должно совпадать с npx-прогонами по транскриптам. cacheOnly
    // отдаёт лучшее, что есть (память/диск, пусть и протухшее — с пометкой
    // stale + kind 'deferred'), и НЕ спавнит ничего; без кэша — честный
    // ok:false 'deferred', дашборд объяснит.
    if (cacheOnly) {
      if (lastGood) return buildResult(true, true, lastGood, lastGood.fetchedAt, 'deferred');
      return buildResult(false, false, null, 0, 'deferred');
    }

    const result = await fetchFresh();
    if (result.kind) {
      return applyError(result.kind);
    }

    lastGood = { ...result.data, fetchedAt: nowMs };
    try {
      cache.write(lastGood);
    } catch (err) {
      // запись кэша упала — не критично, отдаём свежие данные всё равно.
    }
    return buildResult(true, false, lastGood, nowMs, null);
  }

  // single-flight (см. комментарий у объявления inFlight выше): если запрос
  // уже выполняется, возвращаем ТОТ ЖЕ промис вместо второго fetchFresh().
  // opts вызова-«присоединившегося» при этом игнорируется (в т.ч. его
  // собственный force:true) — он получит результат уже идущего запроса;
  // doGet() сама никогда не бросает, так что .finally() достаточно, чтобы
  // гарантированно сбросить inFlight по завершении (успех или уже пойманная
  // внутри ошибка — без разницы).
  async function get(opts = {}) {
    if (inFlight) return inFlight;
    inFlight = doGet(opts).finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  return { get };
}

module.exports = { createCcusage };
