// Ленивые запросы при открытии дашборда: usage:get и gh:global.
//
// Вынесено из app.js (ревью 09.08, C17), чтобы поведение проверялось тестом
// (test/dashboard-fetch.test.js) — app.js под node --test не поднимается.
// app.js зовёт ровно эту функцию, передавая доступ к своим lastUsage/lastGh.
//
// FIX 2 (ревью): дашборд открывался ИСКЛЮЧИТЕЛЬНО на lastUsage, снятом при
// первом usage:get() в boot() — если кокпит простоял открытым несколько
// часов, 10-минутный TTL внутри usage-ccusage.js в авто-режиме не мог
// сработать НИКОГДА (только явный клик «Обновить» вообще бил по сети), и
// пользователь в конце дня видел утренние цифры как актуальные, без единого
// намёка на возраст. Вызывается из dashboard.js/open() при КАЖДОМ открытии —
// window.api.usage.get() (НЕ usage:refresh!) сам уважает TTL: если кэш
// свежий, реального npx не будет, это дешёвый no-op. redraw() уже умеет
// перерисовать дашборд, если он сейчас открыт, — а он открыт, раз это вообще
// было вызвано.
// Task 4 фазы 6: тем же обработчиком (тот же принцип «лениво, при каждом
// открытии») тянем сводку GitHub (gh:global). ВАЖНО: usage.get() и gh.global()
// запускаются НЕЗАВИСИМО (каждый — свой .then/.catch, тот же fire-and-forget
// приём, что и первичный usage.get() в boot()), а НЕ через один общий await —
// первый вызов usage.get() (ленивый ccusage.get() внутри может спавнить npx,
// до 60с по таймауту) не должен задерживать отрисовку раздела GitHub, если тот
// уже готов раньше. Каждый источник сам зовёт redraw() по своему разрешению —
// раздел «загружаю…» (dashboard.js/buildGithubSection) сменится на реальные
// данные ровно тогда, когда придёт ИМЕННО его ответ, а не когда придут оба
// разом.
// FIX (ревью задачи 4 фазы 6, carryover в задачу 5): раньше оба .catch ниже
// только логировали ошибку в консоль — ни lastUsage/lastGh, ни перерисовка
// не трогались. window.api.usage.get()/gh.global() штатно НЕ бросают (main
// сам ловит любой сбой и отдаёт {ok:false,...} через .then) — .catch здесь
// это на случай РЕАЛЬНОГО отказа промиса (обрыв IPC-моста, исключение вне
// try/catch и т.п.). Без присвоения+редро в этой ветке плашка «загружаю…» у
// раздела GitHub (dashboard.js/buildGithubSection: gh===null → «загружаю…»)
// виснет навсегда до полного закрытия и повторного открытия дашборда — ни
// один последующий тик (usage:update, таймер 30с) её не перерисует, потому
// что lastGh как был null, так и остаётся. Синтетика ok:false — та же форма,
// что и настоящий error-путь usage-oauth.js/usage-ccusage.js/gh-info.js,
// dashboard.js уже умеет её рисовать («недоступны»/SPEND_UNAVAILABLE_TEXT/
// ghErrorText с фолбэком на неизвестный код).
// C17 (ревью 09.08): синтетика — ТОЛЬКО если не было ничего. Раньше отказ
// затирал и валидный lastUsage — кольца «5Ч»/«НЕДЕЛЯ» и дашборд гасли в
// прочерки, хотя цифры были на руках. Известные данные лучше «failed»: их
// возраст дашборд и так показывает, а следующий usage:update их обновит.
//
// usage/gh — доступ к переменным app.js: { get(), set(value) }.
// Возвращает промис, который разрешается, когда оба запроса отработали
// (нужен тесту; dashboard.js результат onOpen не смотрит).
export function fetchOnDashboardOpen({ api, usage, gh, redraw }) {
  const usageDone = api.usage.get().then((v) => {
    usage.set(v);
    redraw();
  }).catch((err) => {
    console.warn('[usage] usage:get при открытии дашборда не удался:', err);
    if (!usage.get()) {
      usage.set({
        limits: { ok: false, error: 'failed', fetchedAt: 0 },
        spend: { ok: false, error: 'failed' },
      });
    }
    redraw();
  });

  const ghDone = api.gh.global().then((v) => {
    gh.set(v);
    redraw();
  }).catch((err) => {
    console.warn('[gh] gh:global при открытии дашборда не удался:', err);
    if (!gh.get()) {
      gh.set({
        ok: false, error: 'failed', prs: [], issues: [], notifications: 0,
      });
    }
    redraw();
  });

  return Promise.all([usageDone, ghDone]);
}
