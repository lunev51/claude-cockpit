# Carryover из финального ревью Фазы 1 → в план Фазы 2

Источник: whole-branch review ветки phase1-shell (7c3cd4c..a320aca), все Critical/Important
закрыты фикс-волной a320aca. Ниже — то, что сознательно отложено.

## Учесть при написании плана Фазы 2

1. **`manager.open()` принимает только `{cwd, smoke}`** — для авто-resume нужны per-tab
   `command/args` (`claude --resume <id>`). Шов расширения готов, контракт задекларирован
   в плане Фазы 1 шире, чем реализован. Расширить open()/spawn() и покрыть тестом.
2. **Нейминг статусов**: tabs.js даёт `working/waiting/done/error/idle`; спека §5.2 —
   `working/waiting/done/stuck/dead`. Решить нейминг при реализации машины статусов
   (stuck — новый CSS-класс; текущий error семантически = dead).
3. **`initTerminal` не имеет dispose()** — ResizeObserver не отключается при закрытии
   вкладки (мягкая утечка). Добавить teardown-метод и звать из closeTab.
4. **Фолбэк при закрытии активной вкладки** — активируется rest[last], а не сосед
   закрытой. Починить попутно при доработке tabs.js.
5. **Латентный edge**: синхронный onExit из фабрики ДО присвоения tab.proc обойдёт
   identity-гарды (unchanged legacy-поведение). Если Фаза 2 введёт авто-рестарты —
   закрыть generation-counter'ом.
6. **statusFont в boot()** — избыточная строка после per-tab restore (двойная запись,
   безвредно). Убрать попутно.

## Перед первой сборкой дистрибутива (Фаза 6)

- Удалить/исключить `assets/avatar_BACKUP.vrm` (~18 МБ, untracked) — попадёт в portable
  через `build.files: assets/**`.

## Зафиксированные решения (не трогать)

- `npm test` = `node --test` (авто-дискавери): аргумент-папка сломан на Node 24.
- `setStatus(tabId,'working')` в onStarted НЕ избыточен — после рестарта именно он
  сбрасывает красную точку error в working (финальный ревьюер проверил).
