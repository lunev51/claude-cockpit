'use strict';
// Мини-форма ввода (Phase 7, Task 4): одно текстовое поле на каждый
// переданный field — используется и для плейсхолдеров рецепта («Рецепт:
// Обнови зависимости в {{пакет}}» → одно поле «пакет»), и для имени при
// сохранении воркспейса («Сохранить воркспейс…» → одно поле «имя»). Пустой
// массив полей (ревью раунд 1: подтверждение «Открыть воркспейс…» — действие
// необратимо убивает живые сессии) рисует ПРОСТОЙ да/нет-диалог без единого
// текстового поля. Один и тот же оверлей закрывает все три надобности — заводить
// три похожих модуля ради разных вызывающих сценариев смысла не было.
//
// createRecipeForm — единственный владелец своего DOM (тот же стиль, что
// palette.js/dashboard.js: build() внутри open(), полная разборка в close()).
// В отличие от palette/dashboard/peek, у которых open()/close() — раздельные
// методы с внешним состоянием, здесь ОДИН метод open() возвращает Promise:
// вызывающему коду (app.js/runRecipe, saveCurrentWorkspace, openWorkspace)
// нужен именно результат (введённые значения / {} при чистом подтверждении /
// null при отмене), а не колбэк — это ближе к window.prompt()/window.confirm(),
// просто не блокирующему event loop и в стиле дизайн-токенов v2 вместо
// системного диалога ОС.

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

    // Minor 7 (ревью раунд 1): раньше Enter в ЛЮБОМ поле сабмитил форму
    // целиком — рецепт с двумя плейсхолдерами уходил в живую сессию
    // недописанным («Сравни X и »), стоило пользователю по привычке нажать
    // Enter после первого значения (guard на пустоту это не ловит — второе
    // поле формально «заполнено» пустой строкой, а не отсутствует). Теперь
    // Enter в поле переводит фокус на следующее НЕЗАПОЛНЕННОЕ поле; сабмит —
    // только когда ВСЕ поля уже заполнены (правило одинаково для «Enter на
    // последнем поле» и «Enter, когда все давно заполнены, а фокус вернули
    // назад» — оба матчатся под allFilled ниже).
    function firstEmptyIndexFrom(startIndex) {
      for (let i = startIndex; i < inputs.length; i++) {
        if (!inputs[i].input.value.trim()) return i;
      }
      return -1;
    }

    function submit() {
      const values = {};
      for (const { key, input } of inputs) values[key] = input.value;
      finish(values);
    }

    function handleFieldEnter(currentIndex) {
      const allFilled = inputs.every((f) => f.input.value.trim());
      if (allFilled) {
        submit();
        return;
      }
      // Ищем следующее незаполненное поле СТРОГО после текущего; если такого
      // нет (текущее — последнее в форме), но где-то РАНЬШЕ всё ещё есть
      // пустое (пользователь вручную вернулся назад Tab/Shift+Tab и что-то
      // стёр) — едем к самому первому незаполненному по всей форме.
      let next = firstEmptyIndexFrom(currentIndex + 1);
      if (next === -1) next = firstEmptyIndexFrom(0);
      // next может совпасть с currentIndex, только если ЕДИНСТВЕННОЕ пустое
      // поле — само текущее (Enter на нём без значения) — тогда двигаться
      // некуда и сабмитить тоже нечем, остаёмся на месте молча.
      if (next !== -1 && next !== currentIndex) inputs[next].input.focus();
    }

    fields.forEach(({ key, label }, index) => {
      const row = document.createElement('label');
      row.className = 'recipe-form-row';

      const labelEl = document.createElement('span');
      labelEl.className = 'recipe-form-label';
      labelEl.textContent = label;
      row.appendChild(labelEl);

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'recipe-form-input';
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          handleFieldEnter(index);
        }
      });
      row.appendChild(input);

      panel.appendChild(row);
      inputs.push({ key, input });
    });

    let firstFocusable = inputs[0]?.input || null;

    if (inputs.length) {
      const hint = document.createElement('div');
      hint.className = 'recipe-form-hint';
      hint.textContent = 'Enter — следующее поле/подтвердить · Esc — отмена';
      panel.appendChild(hint);
    } else {
      // Форма-подтверждение без полей (ревью раунд 1: «Открыть воркспейс…» —
      // необратимое действие, спрашиваем да/нет explicit-кнопками, а не
      // голым Enter в никуда — здесь нет input, на который можно поставить
      // фокус, поэтому фокус получает сама кнопка подтверждения, тот же
      // приём, что #restore-overlay/.restore-actions). {} — валидный, но
      // пустой результат «подтверждено» (в отличие от null у отмены).
      const actions = document.createElement('div');
      actions.className = 'recipe-form-actions';

      const confirmBtn = document.createElement('button');
      confirmBtn.type = 'button';
      confirmBtn.className = 'sidebar-btn';
      confirmBtn.textContent = 'Подтвердить (Enter)';
      confirmBtn.addEventListener('mousedown', (ev) => ev.preventDefault());
      confirmBtn.addEventListener('click', () => finish({}));

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'sidebar-btn';
      cancelBtn.textContent = 'Отмена (Esc)';
      cancelBtn.addEventListener('mousedown', (ev) => ev.preventDefault());
      cancelBtn.addEventListener('click', () => finish(null));

      actions.append(confirmBtn, cancelBtn);
      panel.appendChild(actions);
      firstFocusable = confirmBtn;
    }

    overlay.appendChild(panel);
    overlay.addEventListener('mousedown', onOverlayMousedown);
    return { overlay, firstFocusable };
  }

  // open({title, fields}) → Promise<Record<string,string>|{}|null>. fields —
  // [{key,label}] (мини-форма) ИЛИ отсутствует/пустой массив (чистое
  // подтверждение да/нет, см. build() выше). null в результате —
  // пользователь отменил (Esc/клик вне панели/кнопка «Отмена»).
  function open({ title, fields }) {
    // На практике второй open() до finish() первого не должен случаться —
    // единственные вызывающие места (app.js/runRecipe, saveCurrentWorkspace,
    // openWorkspace) сами однопоточны с точки зрения пользовательского
    // действия. Но на всякий случай не теряем уже ожидающий промис молча —
    // отменяем его.
    if (resolveFn) finish(null);

    return new Promise((resolve) => {
      resolveFn = resolve;

      const active = document.activeElement;
      previousActive = (active && active !== document.body && document.contains(active))
        ? active
        : null;

      const list = Array.isArray(fields) ? fields : [];
      const { overlay, firstFocusable } = build(title, list);
      overlayEl = overlay;
      root.appendChild(overlayEl);

      document.addEventListener('keydown', onDocKeydown, true);
      firstFocusable?.focus();
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
