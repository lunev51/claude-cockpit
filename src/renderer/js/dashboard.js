'use strict';
// Дашборд лимитов и расходов (Task 4 фазы 5): оверлей поверх терминальной
// области (как restore-оверлей, см. app.css/#restore-overlay), а НЕ отдельная
// вкладка. createDashboard — единственный владелец своего DOM, весь оверлей
// строится в open() и разбирается в close() (тот же приём, что палитра —
// palette.js/build()+close() — а не статическая разметка + toggle .hidden,
// как у restore-overlay, который показывается ровно один раз за старт).
// Модуль ничего не знает о usage-oauth.js/usage-ccusage.js напрямую — только
// про формы снапшотов {limits, spend}, которые приносит инжектированный
// getData(); сеть/повторный запрос — исключительно через onRefresh().

import { formatCountdown } from './countdown.js';
import {
  formatTokens, formatUsd, formatShortDate,
} from './format.js';

const CHART_PRESETS = [7, 30];
const DEFAULT_CHART_PRESET = 7;

// Пороги окраски — те же, что в rings.js (бриф: <60 → ok, 60..85 → warn, >85 → err).
function colorFor(percent) {
  if (percent > 85) return 'var(--err)';
  if (percent >= 60) return 'var(--warn)';
  return 'var(--ok)';
}

// Коды ошибок слоя A (usage-oauth.js: 'auth'|'network'|'rate') → человеко-читаемая причина.
const LIMITS_ERROR_TEXT = {
  auth: 'не удалось подтвердить OAuth-токен',
  network: 'сетевая ошибка при обращении к серверу лимитов',
  rate: 'превышен лимит запросов — подождите и обновите позже',
};

function limitsErrorText(error) {
  return LIMITS_ERROR_TEXT[error] || error || 'причина неизвестна';
}

const SPEND_UNAVAILABLE_TEXT = 'расходы недоступны: ccusage не запустился — попробуйте «Обновить»';

export function createDashboard({
  root, getData, onRefresh, fallbackFocus,
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

  // buildSpendMeta(): только маркер «оценка» — пометку «данные устарели»
  // отсюда убрали (fix ревью, см. buildLimitsSection/render): она рисуется
  // безусловно у секции лимитов, а не только когда блок расходов вообще
  // успел отрисоваться.
  function buildSpendMeta() {
    const meta = document.createElement('div');
    meta.className = 'dashboard-spend-meta';

    // Данные слоя B — оценка по локальным транскриптам (бриф), а не
    // авторитетный биллинг Anthropic — помечаем это всегда, пока блок расходов
    // вообще показан.
    const badge = document.createElement('span');
    badge.className = 'dashboard-badge-estimate';
    badge.textContent = 'оценка';
    meta.appendChild(badge);

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

  function buildCardsSection(spend) {
    const wrap = document.createElement('div');
    wrap.className = 'dashboard-cards';
    const totals = spend.totals || { costUsd: 0, tokens: 0, sessions: 0 };
    const avg = totals.sessions > 0 ? formatUsd(totals.costUsd / totals.sessions) : '—';
    wrap.appendChild(buildCard('Расход', formatUsd(totals.costUsd)));
    wrap.appendChild(buildCard('Токены', formatTokens(totals.tokens)));
    wrap.appendChild(buildCard('Сессии', String(totals.sessions || 0)));
    wrap.appendChild(buildCard('Средняя цена сессии', avg));
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

  function renderChartBars(barsHost, byDay) {
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
    slice.forEach((d, i) => {
      const bar = document.createElement('div');
      bar.className = 'chart-bar';
      // Минимум 2% высоты — нулевой/почти нулевой день остаётся видимым
      // штрихом, а не пропадает из сетки полностью.
      const h = maxCost > 0 ? Math.max(2, Math.round((d.costUsd / maxCost) * 100)) : 2;
      bar.style.height = `${h}%`;
      bar.title = `${formatShortDate(d.date)}: ${formatUsd(d.costUsd)}, ${formatTokens(d.tokens)} токенов`;
      // Подпись даты под каждым 5-м баром (бриф), считая от начала видимого среза.
      if (i % 5 === 0) {
        const label = document.createElement('span');
        label.className = 'chart-bar-label';
        label.textContent = formatShortDate(d.date);
        bar.appendChild(label);
      }
      barsHost.appendChild(bar);
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
    renderChartBars(bars, Array.isArray(spend.byDay) ? spend.byDay : []);
    section.appendChild(bars);

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
      empty.textContent = SPEND_UNAVAILABLE_TEXT;
      bodyEl.appendChild(empty);
      return;
    }

    bodyEl.appendChild(buildSpendMeta());
    bodyEl.appendChild(buildCardsSection(spend));
    bodyEl.appendChild(buildTableSection(spend));
    bodyEl.appendChild(buildChartSection(spend));
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
      // onRefresh может вернуть тот же снапшот (single-flight/троттлинг главного
      // процесса уже мог отбить лишний реальный запрос, см. ipc.js) — render()
      // всё равно безвреден на неизменных данных, идемпотентная перерисовка.
      if (fresh) render(fresh, Date.now());
    } catch (err) {
      console.warn('[dashboard] обновление не удалось:', err);
    } finally {
      refreshing = false;
      refreshBtn.disabled = false;
      refreshBtn.textContent = 'Обновить';
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
