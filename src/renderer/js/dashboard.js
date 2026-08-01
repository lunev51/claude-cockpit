'use strict';
// Дашборд лимитов и расходов (Task 4 фазы 5): оверлей поверх терминальной
// области (как restore-оверлей, см. app.css/#restore-overlay), а НЕ отдельная
// вкладка. createDashboard — единственный владелец своего DOM, весь оверлей
// строится в open() и разбирается в close() (тот же приём, что палитра —
// palette.js/build()+close() — а не статическая разметка + toggle .hidden,
// как у restore-overlay, который показывается ровно один раз за старт).
// Модуль ничего не знает о usage-oauth.js/usage-ccusage.js/gh-info.js/
// night-watch.js напрямую — только про формы снапшотов {limits, spend, gh,
// night}, которые приносит инжектированный getData(); сеть/повторный запрос —
// исключительно через onRefresh() (ручное «Обновить», форсирует реальный npx
// для usage; раздел GitHub эта кнопка не трогает — см. app.js/refreshUsage) и
// onOpen() (FIX 2 ревью: тихий вызов при каждом open(), уважает TTL слоя
// ccusage сам; Task 4 фазы 6 — тем же вызовом лениво тянет и gh:global, см.
// app.js/fetchUsageOnDashboardOpen). Task 3 фазы 8 («Ночная смена»): .night —
// снапшот night:get, обновляемый ЖИВЬЁМ через push night:changed (app.js
// держит его в модульном кэше nightState всегда, не только при открытии
// дашборда, — не нужен отдельный ленивый onOpen-запрос, в отличие от gh).
// api (Task 4 фазы 6) — инжектированный window.api целиком (тот же приём, что
// diffpanel.js) — используется только для api.shell.openExternal() при клике
// по строке раздела GitHub. resolveTabName (Task 3 фазы 8, Important 2 ревью
// раунда 1) — необязательная функция tabId→имя для журнала ночной секции, см.
// createDashboard ниже.

import { formatCountdown } from './countdown.js';
import {
  formatTokens, formatUsd, formatShortDate,
} from './format.js';
// Task 3 фазы 8 («Ночная смена»): секция дашборда — чистый маппинг журнала/
// строки состояния вынесен в night-format.js (см. там же, покрыт тестом через
// динамический import()), здесь только сборка DOM (buildNightSection ниже).
import {
  nightStatusLine, recentJournalEntries, formatJournalLine,
} from './night-format.js';

const CHART_PRESETS = [7, 30];
const DEFAULT_CHART_PRESET = 7;

// Пороги окраски — те же, что в rings.js (бриф: <60 → ok, 60..85 → warn, >85 → err).
function colorFor(percent) {
  if (percent > 85) return 'var(--err)';
  if (percent >= 60) return 'var(--warn)';
  return 'var(--ok)';
}

// Коды ошибок слоя A (usage-oauth.js: 'auth'|'network'|'rate'|'failed') →
// человеко-читаемая причина. Находка 10 (ревью фазы 6, минор): без ключа
// 'failed' фолбэк ниже (limitsErrorText) отдавал сырой код как есть —
// пользователь видел «Лимиты недоступны: failed» вместо связного текста.
const LIMITS_ERROR_TEXT = {
  auth: 'не удалось подтвердить OAuth-токен',
  network: 'сетевая ошибка при обращении к серверу лимитов',
  rate: 'превышен лимит запросов — подождите и обновите позже',
  failed: 'не удалось получить данные — попробуйте «Обновить»',
};

function limitsErrorText(error) {
  return LIMITS_ERROR_TEXT[error] || error || 'причина неизвестна';
}

const SPEND_UNAVAILABLE_TEXT = 'расходы недоступны: ccusage не запустился — попробуйте «Обновить»';

// FIX 2 (ревью): «обновлено в HH:MM» рядом с маркерами «оценка»/лимитов —
// fetchedAt уже приходит в обоих снапшотах (limits/spend), лишнего IPC не
// требует. ms<=0 — «данных ещё не было» (buildResult/zeroSnapshot кладут туда
// 0), отдаём null, а не «01.01.1970».
function formatTime(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Коды ошибок ghInfo.getRepo/getGlobal ('no-gh'|'auth'|'failed') → человеко-
// читаемая причина для пустых состояний раздела GitHub (бриф §Task 4 фазы 6).
// Находка 4 (carryover ревью фазы 6, задача 5 фазы 7): без ключа 'failed'
// фолбэк ниже (ghErrorText) отдавал общий текст «GitHub недоступен» — тот же
// класс находки, что уже чинили у LIMITS_ERROR_TEXT выше, только для другой
// карты (gh-info.js, а не usage-oauth.js).
const GH_ERROR_TEXT = {
  'no-gh': 'gh не установлен',
  auth: 'gh не авторизован',
  failed: 'не удалось получить данные — попробуйте «Обновить»',
};

function ghErrorText(error) {
  return GH_ERROR_TEXT[error] || 'GitHub недоступен';
}

// resolveTabName (Task 3 фазы 8, Important 2 ревью раунда 1) — необязательная
// функция tabId→имя, инжектированная app.js (tabStore.peekInfo(tabId)?.name),
// прокидывается насквозь в night-format.js/journalEntryText (см.
// buildNightSection ниже) — без неё журнал ночной секции неотличим по
// вкладкам («какая именно пропущена»).
export function createDashboard({
  root, getData, onRefresh, onOpen, fallbackFocus, api, resolveTabName,
}) {
  let isOpenFlag = false;
  let overlayEl = null;
  let refreshBtn = null;
  let bodyEl = null; // контент — перерисовывается целиком при каждом render()
  let previousActive = null;
  let refreshing = false;
  let chartPreset = DEFAULT_CHART_PRESET;
  let lastData = null; // последний отрендеренный {limits, spend} — presets графика перерисовывают без нового getData()

  // --- Построение секций контента ---

  function buildLimitBar(label, part, ok, now) {
    const row = document.createElement('div');
    row.className = 'limit-bar-row';

    const labelEl = document.createElement('div');
    labelEl.className = 'limit-bar-label';
    labelEl.textContent = label;
    row.appendChild(labelEl);

    const track = document.createElement('div');
    track.className = 'limit-bar-track';
    const fill = document.createElement('div');
    fill.className = 'limit-bar-fill';
    // Защитная проверка типа — тот же приём, что rings.js/buildRing для той же
    // формы данных (fiveHour/sevenDay): percent может отсутствовать или быть
    // не-числом (неполные/битые данные слоя A) даже когда ok:true — без этой
    // проверки Math.round(undefined) даёт NaN, и пользователь увидел бы полосу
    // «NaN%» вместо аккуратного прочерка.
    const hasPercent = ok && !!part && typeof part.percent === 'number';
    const pct = hasPercent ? Math.max(0, Math.min(100, Math.round(part.percent))) : 0;
    fill.style.width = `${pct}%`;
    fill.style.background = hasPercent ? colorFor(pct) : 'var(--text-dim)';
    track.appendChild(fill);
    row.appendChild(track);

    const pctEl = document.createElement('div');
    pctEl.className = 'limit-bar-pct';
    pctEl.textContent = hasPercent ? `${pct}%` : '—';
    row.appendChild(pctEl);

    const resetEl = document.createElement('div');
    resetEl.className = 'limit-bar-reset';
    resetEl.textContent = hasPercent ? `сброс через ${formatCountdown(part.resetsAt, now)}` : '—';
    row.appendChild(resetEl);

    return row;
  }

  // buildLimitsSection(limits, stale, now): stale — вычислен ОДИН РАЗ в
  // render() (см. комментарий там) и рисуется здесь БЕЗУСЛОВНО, независимо от
  // ok/scoped/ошибок — секция лимитов единственное место дашборда, которое
  // гарантированно строится при каждом render(), поэтому пометка «устарело»
  // живёт именно тут, а не в блоке расходов (см. buildSpendMeta).
  function buildLimitsSection(limits, stale, now) {
    const section = document.createElement('div');
    section.className = 'dashboard-section dashboard-limits';

    const title = document.createElement('div');
    title.className = 'dashboard-section-title';
    title.textContent = 'Лимиты';
    section.appendChild(title);

    const ok = !!(limits && limits.ok);
    const fiveHour = (limits && limits.fiveHour) || null;
    const sevenDay = (limits && limits.sevenDay) || null;

    section.appendChild(buildLimitBar('5-часовое окно', fiveHour, ok, now));
    section.appendChild(buildLimitBar('Неделя', sevenDay, ok, now));

    if (stale) {
      // Fix ревью: раньше пометка «данные устарели» рисовалась ИСКЛЮЧИТЕЛЬНО
      // внутри buildSpendMeta() (блок расходов) — при недоступных расходах
      // (!spend || !spendOk) render() выходил ДО вызова buildSpendMeta(), и
      // пользователь видел аккуратные проценты лимитов и обратный отсчёт БЕЗ
      // единой пометки, что данные (слой A — лимиты, ИЛИ слой B — расходы)
      // на самом деле устарели (реалистичный сценарий: сеть моргнула/токен
      // протух → 15-минутный бэкофф лимитов, а ccusage при этом не запустился).
      // Интерфейс молча врал — теперь пометка привязана к секции лимитов и
      // рисуется независимо от того, отрисовались ли расходы вообще.
      const staleEl = document.createElement('div');
      staleEl.className = 'dashboard-badge-stale dashboard-limits-stale';
      staleEl.textContent = 'данные устарели';
      section.appendChild(staleEl);
    }

    // FIX 2 (ревью): usage:get дёргался РОВНО ОДИН РАЗ в boot() — открытие
    // дашборда никогда не перезапрашивало данные, поэтому 10-минутный TTL
    // внутри usage-ccusage.js в авто-режиме не мог сработать НИКОГДА (только
    // явный клик «Обновить»), а stale-бейдж молчал, если сам снапшот при этом
    // формально ok:true. Единственный честный сигнал «насколько это свежо» —
    // время получения, показываем его безусловно, если оно вообще есть.
    const limitsTime = formatTime(limits && limits.fetchedAt);
    if (limitsTime) {
      const updatedEl = document.createElement('div');
      updatedEl.className = 'dashboard-updated-at dashboard-limits-updated';
      updatedEl.textContent = `обновлено в ${limitsTime}`;
      section.appendChild(updatedEl);
    }

    if (!ok) {
      // Пустое состояние лимитов (бриф §4): прочерки уже нарисованы полосами
      // выше (ok:false → buildLimitBar сама рисует «—»/«—»), здесь только
      // причина.
      const errEl = document.createElement('div');
      errEl.className = 'dashboard-limits-error';
      errEl.textContent = `Лимиты недоступны: ${limitsErrorText(limits && limits.error)}`;
      section.appendChild(errEl);
    } else {
      // Строки по моделям (бриф): только percent > 0, иначе секцию не показываем.
      const scoped = (limits.scoped || []).filter((s) => s && s.percent > 0);
      if (scoped.length) {
        const scopedWrap = document.createElement('div');
        scopedWrap.className = 'dashboard-scoped';
        for (const s of scoped) {
          // s уже прошёл фильтр percent > 0 выше — hasPercent внутри
          // buildLimitBar тем не менее сам проверит typeof на случай будущих
          // некорректных данных, а не только сам факт > 0.
          scopedWrap.appendChild(buildLimitBar(s.label, s, true, now));
        }
        section.appendChild(scopedWrap);
      }
    }

    return section;
  }

  // buildSpendMeta(spend): маркер «оценка» + FIX 2 (ревью) — «обновлено в
  // HH:MM» из spend.fetchedAt. Пометку «данные устарели» отсюда убрали ранее
  // (fix ревью, см. buildLimitsSection/render): она рисуется безусловно у
  // секции лимитов, а не только когда блок расходов вообще успел отрисоваться.
  function buildSpendMeta(spend) {
    const meta = document.createElement('div');
    meta.className = 'dashboard-spend-meta';

    // Данные слоя B — оценка по локальным транскриптам (бриф), а не
    // авторитетный биллинг Anthropic — помечаем это всегда, пока блок расходов
    // вообще показан.
    const badge = document.createElement('span');
    badge.className = 'dashboard-badge-estimate';
    badge.textContent = 'оценка';
    meta.appendChild(badge);

    const time = formatTime(spend && spend.fetchedAt);
    if (time) {
      const updated = document.createElement('span');
      updated.className = 'dashboard-updated-at';
      updated.textContent = `обновлено в ${time}`;
      meta.appendChild(updated);
    }

    return meta;
  }

  function buildCard(label, value) {
    const card = document.createElement('div');
    card.className = 'dashboard-card-tile';
    const l = document.createElement('div');
    l.className = 'tile-label';
    l.textContent = label;
    const v = document.createElement('div');
    v.className = 'tile-value';
    v.textContent = value;
    card.append(l, v);
    return card;
  }

  // FIX 1 (ревью): spend.totals.costUsd/tokens — агрегат ccusage ЗА ВСЮ
  // ИСТОРИЮ аккаунта (usage-ccusage.js/normalize берёт их прямо из
  // dailyBody.totals, а НЕ пересчитывает по срезанному byDay — см. комментарий
  // и тест там же). На реальных данных карточка «Расход» показывала $3497,
  // пока соседние столбики графика были ~$26/день — подпись без указания
  // периода читалась как «расход за последнее время». spend.byDay уже
  // нарезан до последних 30 дней (normalize: byDayAll.slice(-30)) — суммируем
  // его сами и подписываем честно. totals оставляем только для «всего»-метрик
  // (сессии/средний чек) — ccusage не отдаёт «сессии за 30 дней» отдельно.
  function buildCardsSection(spend) {
    const wrap = document.createElement('div');
    wrap.className = 'dashboard-cards';
    const totals = spend.totals || { costUsd: 0, tokens: 0, sessions: 0 };
    const byDay = Array.isArray(spend.byDay) ? spend.byDay : [];
    const last30CostUsd = byDay.reduce((sum, d) => sum + (Number(d && d.costUsd) || 0), 0);
    const last30Tokens = byDay.reduce((sum, d) => sum + (Number(d && d.tokens) || 0), 0);
    const avg = totals.sessions > 0 ? formatUsd(totals.costUsd / totals.sessions) : '—';
    wrap.appendChild(buildCard('Расход за 30 дней', formatUsd(last30CostUsd)));
    wrap.appendChild(buildCard('Токены за 30 дней', formatTokens(last30Tokens)));
    wrap.appendChild(buildCard('Сессии (всего)', String(totals.sessions || 0)));
    wrap.appendChild(buildCard('Средняя цена сессии (всего)', avg));
    return wrap;
  }

  function buildTableSection(spend) {
    const section = document.createElement('div');
    section.className = 'dashboard-section';

    const title = document.createElement('div');
    title.className = 'dashboard-section-title';
    title.textContent = 'По проектам';
    section.appendChild(title);

    const byProject = Array.isArray(spend.byProject) ? spend.byProject : [];
    if (!byProject.length) {
      const empty = document.createElement('div');
      empty.className = 'dashboard-table-empty';
      empty.textContent = 'Нет данных по проектам';
      section.appendChild(empty);
      return section;
    }

    const table = document.createElement('table');
    table.className = 'dashboard-table';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    ['Проект', 'Токены', '$', 'Активность'].forEach((text) => {
      const th = document.createElement('th');
      th.textContent = text;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    // Сортировка уже сделана слоем данных (usage-ccusage.js: byProject
    // отсортирован по costUsd убыв.) — здесь НЕ пересортировываем (бриф).
    for (const p of byProject) {
      const tr = document.createElement('tr');

      const tdName = document.createElement('td');
      tdName.className = 'dashboard-table-name';
      tdName.textContent = p.name;
      tdName.title = p.name;
      tr.appendChild(tdName);

      const tdTokens = document.createElement('td');
      tdTokens.textContent = formatTokens(p.tokens);
      tr.appendChild(tdTokens);

      const tdCost = document.createElement('td');
      tdCost.textContent = formatUsd(p.costUsd);
      tr.appendChild(tdCost);

      const tdActive = document.createElement('td');
      tdActive.textContent = formatShortDate(p.lastActive);
      tr.appendChild(tdActive);

      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    section.appendChild(table);
    return section;
  }

  // hintEl — строка в заголовке секции: по умолчанию показывает единицы
  // измерения, при наведении на колонку — точные цифры её дня (живая приёмка
  // фазы 7: системный title не работал — у столбика в 2-3px некуда попасть
  // курсором, плюс секундная задержка нативной подсказки; поэтому зона
  // наведения — ВСЯ колонка на высоту графика, а вывод мгновенный и в
  // фиксированном месте).
  const CHART_HINT_DEFAULT = '$ за день · наведи на столбик';

  function renderChartBars(barsHost, byDay, hintEl) {
    barsHost.textContent = '';
    const slice = byDay.slice(-chartPreset);
    if (!slice.length) {
      const empty = document.createElement('div');
      empty.className = 'dashboard-chart-empty';
      empty.textContent = 'Нет данных за период';
      barsHost.appendChild(empty);
      return;
    }
    const maxCost = slice.reduce((m, d) => Math.max(m, d.costUsd), 0);
    // Живая приёмка фазы 7: высота столбиков ничего не говорила — ни единиц,
    // ни масштаба. Подписываем ЗНАЧЕНИЕ над столбиком-максимумом (он задаёт
    // масштаб всей сетки: остальные — доли от него); каждое из 30 значений
    // не подписать — 10px-цифры слипнутся, для точечных цифр есть наведение.
    // При нескольких равных максимумах подписываем первый — остальные видны
    // по одинаковой высоте.
    const maxIdx = slice.findIndex((d) => d.costUsd === maxCost);
    slice.forEach((d, i) => {
      // Колонка на полную высоту графика — hover-мишень; заливка-столбик
      // прижата к её низу.
      const col = document.createElement('div');
      col.className = 'chart-col';

      const bar = document.createElement('div');
      bar.className = 'chart-bar';
      // Минимум 2% высоты — нулевой/почти нулевой день остаётся видимым
      // штрихом, а не пропадает из сетки полностью.
      const h = maxCost > 0 ? Math.max(2, Math.round((d.costUsd / maxCost) * 100)) : 2;
      bar.style.height = `${h}%`;
      if (i === maxIdx && maxCost > 0) {
        const value = document.createElement('span');
        value.className = 'chart-bar-value';
        value.textContent = formatUsd(d.costUsd);
        bar.appendChild(value);
      }
      // Подпись даты под каждым 5-м баром (бриф), считая от начала видимого среза.
      if (i % 5 === 0) {
        const label = document.createElement('span');
        label.className = 'chart-bar-label';
        label.textContent = formatShortDate(d.date);
        bar.appendChild(label);
      }
      col.appendChild(bar);

      if (hintEl) {
        col.addEventListener('mouseenter', () => {
          // «(вкл. кэш)» — живая приёмка фазы 7: 97% дневных токенов обычно
          // кэш-чтения (перечитывание контекста на каждый запрос), они в
          // ~10 раз дешевле обычного ввода — поэтому токены и высота
          // столбика ($) друг другу не пропорциональны, и это не баг.
          hintEl.textContent = `${formatShortDate(d.date)} · ${formatUsd(d.costUsd)} · ${formatTokens(d.tokens)} токенов (вкл. кэш)`;
          hintEl.classList.add('active');
        });
        col.addEventListener('mouseleave', () => {
          hintEl.textContent = CHART_HINT_DEFAULT;
          hintEl.classList.remove('active');
        });
      }
      barsHost.appendChild(col);
    });
  }

  function buildChartSection(spend) {
    const section = document.createElement('div');
    section.className = 'dashboard-section';

    const header = document.createElement('div');
    header.className = 'dashboard-chart-header';
    const title = document.createElement('div');
    title.className = 'dashboard-section-title';
    title.textContent = 'Расход по дням';
    header.appendChild(title);
    // Живая приёмка фазы 7: без пояснения единиц было «непонятно, что
    // конкретно показывают столбики». $ — данные ccusage (те же, что карточка
    // «Расход» выше); при наведении на колонку сюда выводятся точные цифры
    // её дня (см. renderChartBars).
    const hint = document.createElement('span');
    hint.className = 'dashboard-chart-hint';
    hint.textContent = CHART_HINT_DEFAULT;
    header.appendChild(hint);

    const presets = document.createElement('div');
    presets.className = 'dashboard-chart-presets';
    for (const days of CHART_PRESETS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chart-preset';
      btn.classList.toggle('active', days === chartPreset);
      btn.textContent = `${days}д`;
      // mousedown-preventDefault — тот же приём, что action-btn/peek-option/
      // palette-row: без него кнопка отбирает фокус раньше click.
      btn.addEventListener('mousedown', (ev) => ev.preventDefault());
      btn.addEventListener('click', () => {
        if (chartPreset === days) return;
        chartPreset = days;
        // Пересобираем ВЕСЬ дашборд из уже известного lastData — presets не
        // требуют нового getData()/IPC, byDay уже есть целиком (до 30 дней).
        if (lastData) render(lastData, Date.now());
      });
      presets.appendChild(btn);
    }
    header.appendChild(presets);
    section.appendChild(header);

    const bars = document.createElement('div');
    bars.className = 'dashboard-chart-bars';
    renderChartBars(bars, Array.isArray(spend.byDay) ? spend.byDay : [], hint);
    section.appendChild(bars);

    return section;
  }

  // Task 4 фазы 6 (раздел GitHub): одна кликабельная строка — repo #num +
  // заголовок (+ цветная точка статуса проверок, если передан checksClass).
  // Клик открывает url в браузере через api.shell.openExternal — тот же
  // приём, что и бейдж PR в сайдбаре (tabs.js), только api инжектирован сюда
  // конструктором (см. createDashboard), а не глобальным window.api.
  function buildGithubRow({
    left, title, checksClass, url,
  }) {
    const row = document.createElement('div');
    row.className = 'dashboard-github-row';
    if (url) {
      row.classList.add('clickable');
      row.addEventListener('click', () => api.shell.openExternal(url));
    }

    if (checksClass) {
      const dot = document.createElement('span');
      dot.className = `dashboard-github-dot ${checksClass}`;
      row.appendChild(dot);
    }

    const leftEl = document.createElement('span');
    leftEl.className = 'dashboard-github-repo';
    leftEl.textContent = left;
    row.appendChild(leftEl);

    const titleEl = document.createElement('span');
    titleEl.className = 'dashboard-github-row-title';
    titleEl.textContent = title || '';
    if (title) titleEl.title = title;
    row.appendChild(titleEl);

    return row;
  }

  // Находка 7 (ревью фазы 6, минор): atLimit:true — search/api упёрся в
  // --limit (см. gh-info.js/prsAtLimit,issuesAtLimit) — список показывает
  // ровно лимит, но реальных элементов может быть больше. Та же честность,
  // которой панель диффа (diffpanel.js) принципиально не жертвует.
  function buildGithubGroup(label, items, emptyText, withChecks, atLimit) {
    const wrap = document.createElement('div');
    wrap.className = 'dashboard-github-group';

    const title = document.createElement('div');
    title.className = 'dashboard-github-group-title';
    title.textContent = label;
    wrap.appendChild(title);

    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'dashboard-github-empty';
      empty.textContent = emptyText;
      wrap.appendChild(empty);
      return wrap;
    }

    for (const item of items) {
      wrap.appendChild(buildGithubRow({
        left: `${item.repo || '?'} #${item.number}`,
        title: item.title,
        checksClass: withChecks ? (item.checks || 'none') : null,
        url: item.url,
      }));
    }

    if (atLimit) {
      const note = document.createElement('div');
      note.className = 'dashboard-github-limit-note';
      note.textContent = `показано ${items.length}, возможно больше`;
      wrap.appendChild(note);
    }
    return wrap;
  }

  // buildGithubSection(gh): gh — снапшот gh:global ({ok, error, prs, issues,
  // notifications, fetchedAt}) или null. null означает «ещё не запрошено в
  // ЭТОМ открытии дашборда» (запрос летит лениво, см. app.js/
  // fetchUsageOnDashboardOpen) — рисуем «загружаю…», а не пустые списки,
  // чтобы не соврать пользователю, что открытых PR и правда нет.
  function buildGithubSection(gh) {
    const section = document.createElement('div');
    section.className = 'dashboard-section dashboard-github';

    const title = document.createElement('div');
    title.className = 'dashboard-section-title';
    title.textContent = 'GitHub';
    section.appendChild(title);

    if (!gh) {
      const loading = document.createElement('div');
      loading.className = 'dashboard-github-loading';
      loading.textContent = 'загружаю…';
      section.appendChild(loading);
      return section;
    }

    if (!gh.ok) {
      const err = document.createElement('div');
      err.className = 'dashboard-github-error';
      err.textContent = ghErrorText(gh.error);
      section.appendChild(err);
      return section;
    }

    const prs = Array.isArray(gh.prs) ? gh.prs : [];
    const issues = Array.isArray(gh.issues) ? gh.issues : [];
    section.appendChild(buildGithubGroup('Мои открытые PR', prs, 'нет открытых PR', true, !!gh.prsAtLimit));
    section.appendChild(buildGithubGroup('Назначенные issues', issues, 'нет назначенных issues', false, !!gh.issuesAtLimit));

    const notifRow = document.createElement('div');
    notifRow.className = 'dashboard-github-notif';
    const notifCount = Number(gh.notifications) || 0;
    // Находка 6/7 (ревью фазы 6, минор): notificationsAtLimit — упёрлись в
    // размер страницы (см. gh-info.js) — «50» без «+» выглядел бы как точный
    // и окончательный итог, хотя реальных непрочитанных может быть больше.
    notifRow.textContent = `Уведомлений: ${notifCount}${gh.notificationsAtLimit ? '+' : ''}`;
    notifRow.addEventListener('click', () => api.shell.openExternal('https://github.com/notifications'));
    section.appendChild(notifRow);

    return section;
  }

  // buildNightSection(night): night — снапшот night:get/night:toggle/
  // night:changed ({armed, pendingCount, wakeAt, resetsHandled, journal}) или
  // null (ещё не пришёл первый ответ night:get в app.js — тот же приём, что gh
  // выше, см. buildGithubSection). Task 3 фазы 8 («Ночная смена»): секция
  // ПОСЛЕ раздела GitHub (бриф). Журнал — последние 20 записей, новые сверху,
  // «HH:MM — текст» (см. night-format.js); пустой журнал → «журнал пуст».
  function buildNightSection(night) {
    const section = document.createElement('div');
    section.className = 'dashboard-section dashboard-night';

    const title = document.createElement('div');
    title.className = 'dashboard-section-title';
    title.textContent = 'Ночная смена';
    section.appendChild(title);

    if (!night) {
      const loading = document.createElement('div');
      loading.className = 'dashboard-night-loading';
      loading.textContent = 'загружаю…';
      section.appendChild(loading);
      return section;
    }

    const status = document.createElement('div');
    status.className = 'dashboard-night-status';
    status.textContent = nightStatusLine(night);
    section.appendChild(status);

    const journalHost = document.createElement('div');
    journalHost.className = 'dashboard-night-journal';
    const entries = recentJournalEntries(night.journal);
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'dashboard-night-journal-empty';
      empty.textContent = 'журнал пуст';
      journalHost.appendChild(empty);
    } else {
      for (const entry of entries) {
        const row = document.createElement('div');
        row.className = 'dashboard-night-journal-row';
        row.textContent = formatJournalLine(entry, resolveTabName);
        journalHost.appendChild(row);
      }
    }
    section.appendChild(journalHost);

    return section;
  }

  // render(data, now): data — {limits, spend} (форма usage:get/usage:refresh/
  // usage:update). Идемпотентная полная перерисовка bodyEl — вызывается и из
  // open(), и повторно извне (см. app.js) при каждом usage:update/локальном
  // тике отсчёта, пока дашборд открыт. Безвредна, если оверлей уже закрыт
  // (bodyEl тогда null) — вызывающему коду не нужно самому проверять isOpen().
  function render(data, now = Date.now()) {
    if (!bodyEl) return;
    lastData = data;
    const limits = data && data.limits;
    const spend = data && data.spend;
    const gh = data && data.gh;

    // Fix ревью (баг): вычисляем «данные устарели» ОДИН РАЗ здесь, а не
    // только внутри buildSpendMeta() — реалистичное сочетание: слой лимитов
    // отдал кэш со stale:true (сеть моргнула/токен протух → 15-минутный
    // бэкофф), а ccusage не смог запуститься (ok:false). Раньше в этом случае
    // render() делал return ДО вызова buildSpendMeta() (см. ветку !spendOk
    // ниже), и пользователь видел проценты лимитов и обратный отсчёт БЕЗ
    // единой пометки, что они несвежие — интерфейс молча врал. Теперь stale
    // передаётся в buildLimitsSection и рисуется там БЕЗУСЛОВНО.
    const stale = !!(limits && limits.stale) || !!(spend && spend.stale);

    bodyEl.textContent = '';
    // Лимиты показываются ВСЕГДА, даже если слой B (расходы) недоступен —
    // бриф §4: «оверлей при этом всё равно открывается и лимиты показывает».
    bodyEl.appendChild(buildLimitsSection(limits, stale, now));

    const spendOk = !!(spend && spend.ok);
    if (!spend || !spendOk) {
      const empty = document.createElement('div');
      empty.className = 'dashboard-spend-empty';
      // Инцидент 8ГБ: первые ~90с после старта подсчёт расходов отложен
      // (cacheOnly, kind 'deferred') — честно говорим «позже», а не «сломано».
      empty.textContent = (spend && spend.error === 'deferred')
        ? 'подсчёт расходов начнётся через минуту после запуска…'
        : SPEND_UNAVAILABLE_TEXT;
      bodyEl.appendChild(empty);
    } else {
      bodyEl.appendChild(buildSpendMeta(spend));
      bodyEl.appendChild(buildCardsSection(spend));
      bodyEl.appendChild(buildTableSection(spend));
      bodyEl.appendChild(buildChartSection(spend));
    }

    // Task 4 фазы 6: раздел GitHub — ПОСЛЕ блока расходов (бриф), рисуется
    // безусловно, независимо от доступности слоёв лимитов/расходов выше (та же
    // логика, что и у buildLimitsSection — ошибка одного источника данных не
    // должна прятать другой).
    bodyEl.appendChild(buildGithubSection(gh));

    // Task 3 фазы 8 («Ночная смена»): секция — ПОСЛЕ GitHub (бриф), та же
    // безусловная сборка независимо от прочих секций.
    bodyEl.appendChild(buildNightSection(data && data.night));
  }

  // --- Оверлей: открытие/закрытие (тот же паттерн, что palette.js) ---

  function onOverlayMousedown(ev) {
    if (ev.target === overlayEl) close();
  }

  // Escape — на document (не window), capture:true — тот же приём, что
  // peek.js/handleDocKeydown. Ctrl+D (повторное открытие/закрытие) ловится
  // отдельно, на уровне window в app.js/bindHotkeys (та же схема, что Ctrl+P
  // у палитры) — сюда не долетает благодаря stopPropagation там.
  function onDocKeydown(ev) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      close();
    }
  }

  async function onRefreshClick() {
    if (refreshing) return;
    refreshing = true;
    refreshBtn.disabled = true;
    refreshBtn.textContent = 'обновляю…';
    try {
      const fresh = await onRefresh();
      // Fix 2 (ревью фазы 6, регресс Task 5): onRefresh — это refreshUsage()
      // (app.js), которая возвращает lastUsage ({limits, spend}) БЕЗ поля .gh —
      // раздел GitHub дашборда вообще не её забота (эта кнопка не должна его
      // трогать, см. комментарий в шапке файла). render(fresh, ...) напрямую
      // подставлял этот урезанный снапшот вместо полного {limits, spend, gh} —
      // раздел GitHub, уже показывавший реальные PR/issues, откатывался обратно
      // в «загружаю…», хотя ничего заново не грузилось. getData() (app.js/
      // dashboardSnapshot) даёт актуальный ПОЛНЫЙ снапшот — {...lastUsage, gh:
      // lastGh} — lastUsage к этому моменту уже обновлён самим onRefresh().
      render(getData ? getData() : fresh, Date.now());
    } catch (err) {
      console.warn('[dashboard] обновление не удалось:', err);
    } finally {
      refreshing = false;
      // FIX 5 (ревью): close() обнуляет refreshBtn (см. close()) — если
      // пользователь закрыл дашборд, пока onRefresh() ещё летел, этот finally
      // выполняется уже ПОСЛЕ close(), и голое refreshBtn.disabled = ... падало
      // с TypeError на null. `refreshBtn?.disabled = ...` — не вариант: нельзя
      // присваивать через optional chaining (SyntaxError), поэтому обычный if.
      if (refreshBtn) {
        refreshBtn.disabled = false;
        refreshBtn.textContent = 'Обновить';
      }
    }
  }

  function build() {
    const overlay = document.createElement('div');
    overlay.className = 'dashboard-overlay';

    const card = document.createElement('div');
    card.className = 'dashboard-card';

    const header = document.createElement('div');
    header.className = 'dashboard-header';

    const title = document.createElement('div');
    title.className = 'dashboard-title';
    title.textContent = 'Лимиты и расходы';
    header.appendChild(title);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sidebar-btn dashboard-refresh-btn';
    btn.textContent = 'Обновить';
    btn.addEventListener('mousedown', (ev) => ev.preventDefault());
    btn.addEventListener('click', onRefreshClick);
    header.appendChild(btn);
    refreshBtn = btn;

    card.appendChild(header);

    const body = document.createElement('div');
    body.className = 'dashboard-body';
    card.appendChild(body);
    bodyEl = body;

    overlay.appendChild(card);
    overlay.addEventListener('mousedown', onOverlayMousedown);

    return overlay;
  }

  // open(): без параметров (контракт задачи) — fallbackFocus инжектирован в
  // конструктор как геттер (функция), а не статическое значение: активная
  // вкладка/фокус на момент открытия резолвится ЗАНОВО при каждом open(), а не
  // один раз при создании дашборда (та же проблема была бы, что и со «старым»
  // document.activeElement в palette.js — см. комментарий там).
  function open() {
    if (isOpenFlag) return; // повторный Ctrl+D — app.js сам решает закрыть (toggle), см. bindHotkeys
    const active = document.activeElement;
    const fb = typeof fallbackFocus === 'function' ? fallbackFocus() : fallbackFocus;
    previousActive = (active && active !== document.body && document.contains(active))
      ? active
      : fb;

    isOpenFlag = true;
    chartPreset = DEFAULT_CHART_PRESET;

    overlayEl = build();
    root.appendChild(overlayEl);
    document.addEventListener('keydown', onDocKeydown, true);

    render(getData ? getData() : null, Date.now());
    refreshBtn?.focus();

    // FIX 2 (ревью): без этого дашборд открывался ИСКЛЮЧИТЕЛЬНО на lastUsage,
    // снятом при первом usage:get() в boot() — если кокпит простоял открытым
    // всё утро, 10-минутный TTL внутри usage-ccusage.js никогда не успевал
    // сработать в авто-режиме (только клик «Обновить» вообще бил по сети), и
    // пользователь в 18:00 видел утренние цифры как актуальные. onOpen —
    // это window.api.usage.get() (см. app.js), а НЕ usage:refresh: TTL сам
    // решит, нужен ли реальный npx, — если кэш свежий, это дешёвый no-op.
    // Результат сюда не возвращается специально: onOpen сам обновляет lastUsage
    // и зовёт redrawUsageViews() (app.js), которая перерисует и кольца
    // сайдбара, и — раз isOpenFlag уже true — этот дашборд через render().
    if (typeof onOpen === 'function') onOpen();
  }

  function close() {
    if (!isOpenFlag) return;
    isOpenFlag = false;
    document.removeEventListener('keydown', onDocKeydown, true);
    overlayEl?.remove();
    overlayEl = null;
    refreshBtn = null;
    bodyEl = null;
    lastData = null;
    refreshing = false;

    const toFocus = previousActive;
    previousActive = null;
    toFocus?.focus?.();
  }

  function isOpen() {
    return isOpenFlag;
  }

  // render — публичный доп. метод (как peek.js/update()), сверх обязательного
  // open()/close()/isOpen() из контракта: app.js зовёт его при каждом
  // usage:update/локальном тике отсчёта, ПОКА дашборд открыт (см. app.js/
  // redrawUsageViews) — без него открытый дашборд не увидел бы фоновое
  // обновление лимитов/расходов до следующего ручного «Обновить».
  return {
    open, close, isOpen, render,
  };
}
