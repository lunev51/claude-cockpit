'use strict';
// Мини-форма ввода (Phase 7, Task 4): одно текстовое поле на каждый
// переданный field — используется и для плейсхолдеров рецепта («Рецепт:
// Обнови зависимости в {{пакет}}» → одно поле «пакет»), и для имени при
// сохранении воркспейса («Сохранить воркспейс…» → одно поле «имя»). Один и
// тот же оверлей закрывает обе надобности брифа (мини-форма плейсхолдеров +
// «спросить имя») — заводить два почти одинаковых модуля ради разных
// вызывающих сценариев смысла не было.
//
// createRecipeForm — единственный владелец своего DOM (тот же стиль, что
// palette.js/dashboard.js: build() внутри open(), полная разборка в close()).
// В отличие от palette/dashboard/peek, у которых open()/close() — раздельные
// методы с внешним состоянием, здесь ОДИН метод open() возвращает Promise:
// вызывающему коду (app.js/runRecipe, app.js/saveCurrentWorkspace) нужен
// именно результат (введённые значения или null при отмене), а не колбэк —
// это ближе к window.prompt(), просто не блокирующему event loop и в стиле
// дизайн-токенов v2 вместо системного диалога ОС.

export function createRecipeForm({ root }) {
  let overlayEl = null;
  let previousActive = null;
  let resolveFn = null; // null — форма сейчас закрыта

  function onOverlayMousedown(ev) {
    if (ev.target === overlayEl) finish(null);
  }

  function onDocKeydown(ev) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      finish(null);
    }
  }

  function finish(result) {
    if (!resolveFn) return; // форма уже закрыта (например, повторный Escape) — no-op
    const resolve = resolveFn;
    resolveFn = null;
    document.removeEventListener('keydown', onDocKeydown, true);
    overlayEl?.remove();
    overlayEl = null;
    const toFocus = previousActive;
    previousActive = null;
    toFocus?.focus?.();
    resolve(result);
  }

  function build(title, fields) {
    const overlay = document.createElement('div');
    overlay.className = 'recipe-form-overlay';

    const panel = document.createElement('div');
    panel.className = 'recipe-form-panel';

    const titleEl = document.createElement('div');
    titleEl.className = 'recipe-form-title';
    titleEl.textContent = title || '';
    panel.appendChild(titleEl);

    const inputs = [];
    fields.forEach(({ key, label }) => {
      const row = document.createElement('label');
      row.className = 'recipe-form-row';

      const labelEl = document.createElement('span');
      labelEl.className = 'recipe-form-label';
      labelEl.textContent = label;
      row.appendChild(labelEl);

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'recipe-form-input';
      row.appendChild(input);

      panel.appendChild(row);
      inputs.push({ key, input });
    });

    function submit() {
      const values = {};
      for (const { key, input } of inputs) values[key] = input.value;
      finish(values);
    }

    panel.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        submit();
      }
    });

    const hint = document.createElement('div');
    hint.className = 'recipe-form-hint';
    hint.textContent = 'Enter — подтвердить · Esc — отмена';
    panel.appendChild(hint);

    overlay.appendChild(panel);
    overlay.addEventListener('mousedown', onOverlayMousedown);
    return { overlay, firstInput: inputs[0]?.input || null };
  }

  // open({title, fields}) → Promise<Record<string,string>|null>. fields —
  // [{key,label}], непустой массив (вызывающий код сам решает, нужна ли форма
  // вообще — см. app.js/runRecipe: без плейсхолдеров форма не открывается).
  // null в результате — пользователь отменил (Esc/клик вне панели).
  function open({ title, fields }) {
    // На практике второй open() до finish() первого не должен случаться —
    // единственные вызывающие места (app.js/runRecipe, saveCurrentWorkspace)
    // сами однопоточны с точки зрения пользовательского действия. Но на
    // всякий случай не теряем уже ожидающий промис молча — отменяем его.
    if (resolveFn) finish(null);

    return new Promise((resolve) => {
      resolveFn = resolve;

      const active = document.activeElement;
      previousActive = (active && active !== document.body && document.contains(active))
        ? active
        : null;

      const list = Array.isArray(fields) ? fields : [];
      const { overlay, firstInput } = build(title, list);
      overlayEl = overlay;
      root.appendChild(overlayEl);

      document.addEventListener('keydown', onDocKeydown, true);
      firstInput?.focus();
    });
  }

  function isOpen() {
    return !!resolveFn;
  }

  // close(): форс-отмена извне (та же роль, что close() у palette/dashboard/
  // search — другие оверлеи закрывают эту форму «за спиной», если открываются
  // сами, см. app.js/toggleDashboard, toggleHistorySearch, bindHotkeys).
  // Эквивалентно тому, как если бы пользователь сам нажал Esc — открывающий
  // await recipeForm.open(...) в app.js получает null, ровно как при отмене.
  function close() {
    finish(null);
  }

  return {
    open, close, isOpen,
  };
}
