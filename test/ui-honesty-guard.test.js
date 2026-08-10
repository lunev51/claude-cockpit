'use strict';
// Интерфейс не молчит и не врёт — стражи по исходнику.
//
// Четыре находки общего ревью (Fable 5, 09.08), один класс: действие либо
// молча не срабатывает, либо сообщает не то, что случилось на самом деле.
// Renderer под node --test не поднимается, а все четыре — про структуру кода,
// поэтому проверяем текстом (тот же приём, что broadcast-guard и
// command-registry.coverage).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer', 'js');
const read = (name) => fs.readFileSync(path.join(RENDERER, name), 'utf8');

const APP_JS = read('app.js');
const CLIPBOARD_JS = read('clipboard.js');
const API_BOOT_JS = read('api-boot.js');

// Тело функции верхнего уровня: от объявления до закрывающей скобки в начале
// строки (в проекте функции верхнего уровня закрываются именно так).
function topLevelBody(source, signature) {
  const start = source.indexOf(signature);
  assert.notStrictEqual(start, -1, `не найдено объявление «${signature}» — страж разъехался с исходником`);
  const rest = source.slice(start);
  const end = rest.search(/\n\}/);
  assert.notStrictEqual(end, -1, `не найден конец функции «${signature}»`);
  return rest.slice(0, end);
}

// --- B1: перезапуск сессии — одна реализация на все двери -------------------

test('перезапуск сессии зовётся только через общую функцию', () => {
  // Дверей к одному действию ТРИ: кнопка ⟳, действие палитры и Ctrl+Shift+R
  // внутри терминала. Кнопка проверяла управление и объясняла отказ тостом, а
  // две другие слали term:restart напрямую и у клиента без управления молча не
  // срабатывали. Тот же класс, что чинили в I2 ревью (Ctrl+O против
  // «+ Проект»).
  //
  // Сканируем ВЕСЬ renderer, а не только app.js: третья дверь жила в
  // terminal.js и мимо стража на одном файле прошла бы незамеченной.
  const byFile = new Map();
  for (const name of fs.readdirSync(RENDERER)) {
    if (!name.endsWith('.js')) continue;
    const hits = read(name).split(/\r?\n/)
      .map((line, i) => ({ code: line.replace(/^\s*\/\/.*/, ''), n: i + 1 }))
      .filter(({ code }) => /window\.api\.term\.restart\s*\(/.test(code))
      .map(({ n }) => n);
    if (hits.length) byFile.set(name, hits);
  }

  // Разрешены ровно два места: общая функция в app.js и запасной путь в
  // terminal.js (на случай, если модуль подняли без колбэка). Всё остальное —
  // новая дверь мимо проверки управления.
  const unexpected = [...byFile.keys()].filter((name) => name !== 'app.js' && name !== 'terminal.js');
  assert.deepStrictEqual(
    unexpected, [],
    `term.restart зовётся напрямую в ${unexpected.join(', ')} — это дверь мимо проверки управления`,
  );
  assert.deepStrictEqual(
    byFile.get('app.js') || [], (byFile.get('app.js') || []).slice(0, 1),
    'в app.js больше одного прямого вызова term.restart — общая функция обойдена',
  );

  const body = topLevelBody(APP_JS, 'function restartSession(');
  assert.match(body, /window\.api\.term\.restart\(/, 'общая функция больше не перезапускает сессию');
  assert.match(body, /requireControl\(/, 'общий перезапуск перестал спрашивать управление');
  assert.match(body, /showToast\(/, 'общий перезапуск перестал объяснять, почему ничего не произошло');

  // Хоткей внутри терминала обязан идти через колбэк, а не в обход.
  const TERMINAL_JS = read('terminal.js');
  assert.match(
    TERMINAL_JS,
    /onRestartRequest\s*\(\s*tabId\s*\)/,
    'Ctrl+Shift+R в terminal.js снова шлёт перезапуск сам, мимо проверки управления',
  );
});

// --- B2: копирование не крадёт фокус ---------------------------------------

test('запасное копирование возвращает фокус прежнему владельцу', () => {
  // В браузере по http Clipboard API недоступен, работает именно этот путь, а
  // «копировать выделением» включено по умолчанию: без возврата фокуса ввод
  // терялся после каждого выделения текста мышью.
  assert.match(
    CLIPBOARD_JS,
    /const previous = doc\.activeElement/,
    'copyText больше не запоминает, у кого забирает фокус',
  );
  const finallyBlock = CLIPBOARD_JS.slice(CLIPBOARD_JS.indexOf('} finally {'));
  assert.match(finallyBlock, /previous\.focus\(\)/, 'фокус не возвращается — ввод после копирования уйдёт в body');
  assert.match(finallyBlock, /doc\.contains\(previous\)/, 'фокус возвращается вслепую, без проверки, что элемент ещё жив');
});

// --- B3: тост про буфер обмена не обгоняет саму запись ----------------------

test('обещание «ссылка в буфере» даётся ПОСЛЕ попытки положить её туда', () => {
  const body = topLevelBody(API_BOOT_JS, '  api.shell.openExternal = async (url) => {');
  const copyAt = body.indexOf('copyText(');
  const toastAt = body.indexOf('cockpit:toast');

  assert.notStrictEqual(copyAt, -1, 'ссылка больше не копируется через общий copyText — по http это снова будет ложь');
  assert.notStrictEqual(toastAt, -1, 'исчез тост о заблокированной ссылке');
  // Замечание ревью фикса: без await `copied` — это Promise, то есть всегда
  // истинный, и тост снова безусловно обещает буфер.
  assert.match(
    body,
    /const copied = await copyText\(/,
    'результат копирования берётся без await — тост опять будет обещать буфер независимо от исхода',
  );
  assert.ok(
    copyAt < toastAt,
    'тост уходит раньше попытки копирования: он снова пообещает буфер, даже когда запись не удалась',
  );
  assert.doesNotMatch(
    body,
    /navigator\.clipboard\.writeText/,
    'прямой navigator.clipboard вернулся — по http он недоступен, для этого и заведён copyText',
  );
});

// --- B4: потеря управления закрывает всё, что предлагает действия -----------

test('потеря управления закрывает палитру, peek и мини-форму', () => {
  // Палитра лежит выше заглушки по z-index, сайдбар ею не накрыт намеренно —
  // то есть после ухода руля человек продолжал видеть кликабельные кнопки, а
  // действия из них отклонялись молча или падали в unhandled rejection.
  const body = topLevelBody(APP_JS, 'function afterControlLost(');
  const bailAt = body.indexOf('if (!restoreOverlayDismiss) return;');
  assert.notStrictEqual(bailAt, -1, 'исчез ранний выход — страж разъехался с кодом');

  // Каждое закрытие проверяем ОТДЕЛЬНО и на позицию тоже: замечание ревью
  // фикса — при проверке позиции только у палитры остальные три можно было
  // перенести за ранний выход, и в обычном случае (оверлея восстановления нет)
  // они бы не выполнялись, а тест оставался зелёным.
  for (const [what, needle] of [
    ['палитра', 'palette?.close()'],
    ['peek', 'peek?.hide()'],
    ['мини-форма рецепта', 'recipeForm?.close()'],
    ['поле очереди', 'closeQueueInput()'],
    ['парковка фокуса на заглушке', 'parkFocusOnCurtain()'],
  ]) {
    const at = body.indexOf(needle);
    assert.notStrictEqual(at, -1, `при потере управления не закрывается ${what} — его действия будут отклоняться молча`);
    assert.ok(
      at < bailAt,
      `${what}: закрытие стоит ЗА ранним выходом — в обычном случае (без оверлея восстановления) не выполнится`,
    );
  }
});

// --- B5: событие, пришедшее во время сверки, не теряется ------------------

test('сверка вкладок помнит про события, пришедшие во время прохода', () => {
  // Одноразовость сверки гасила такие события НАСОВСЕМ: снимок берётся в
  // начале, а проход долгий (attachTab ждёт историю вывода по каждой новой
  // вкладке). Всё, что сосед успел сделать внутри этого окна, попадало в
  // «уже идёт» и терялось до следующего tabs:changed — которого может не быть
  // часами. Это тот же класс, что дважды давал живые жалобы.
  const body = topLevelBody(APP_JS, 'async function syncTabsFromMain(');

  assert.match(
    body,
    /if \(tabsSyncRun\) \{\s*tabsSyncDirty = true;/,
    'событие во время прохода снова просто отбрасывается — состав вкладок разойдётся до следующего события',
  );
  assert.match(
    body,
    /if \(tabsSyncDirty\) \{\s*tabsSyncDirty = false;\s*await syncTabsFromMain\(\);/,
    'после прохода нет пересверки — помеченное грязным состояние так и останется несверенным',
  );

  // Флаг гасится ДО повторного вызова: иначе события, пришедшие уже во время
  // пересверки, потерялись бы ровно так же.
  const gaseAt = body.indexOf('tabsSyncDirty = false;');
  const recallAt = body.indexOf('await syncTabsFromMain();');
  assert.ok(gaseAt !== -1 && recallAt !== -1 && gaseAt < recallAt, 'флаг гасится после пересверки — события снова теряются');

  // Замечание ревью фикса: фаза применения не под try — исключение оттуда
  // перепрыгнет пересверку и оставит состав грязным до следующего события.
  // Якорь именно на ожидание прохода: в теле функции есть и другой catch (у
  // tabs.list внутри), и он делал эту проверку холостой — мутация «убрать
  // catch у await tabsSyncRun» проходила зелёной.
  assert.match(
    body,
    /await tabsSyncRun;\s*\} catch \(err\) \{/,
    'у ожидания прохода нет catch: сбой применения похоронит пересверку и даст unhandled rejection',
  );
});

test('голос в браузере честно называет ограничение, а не жалуется на формат', () => {
  // B11 принят владельцем как ограничение (10.08): по сети запись не доезжает
  // вовсе — recorder отдаёт ArrayBuffer, а транспорт сериализует кадр через
  // JSON.stringify, и на провод уходит пустой объект. Main отвечает «неверный
  // формат WAV», то есть человек получал сообщение про формат там, где не
  // отправился ни один байт.
  //
  // Чинить транспорт не стали, но молчать или врать нельзя — сетевой клиент
  // обязан сказать прямо и не заводить машину голоса вовсе.
  const body = topLevelBody(APP_JS, 'function bindVoiceHotkey(');
  const гейт = body.indexOf('__cockpitNetClient');
  const машина = body.indexOf('createVoiceMachine(');

  assert.notStrictEqual(гейт, -1, 'сетевой клиент снова заводит голосовой ввод, который не может работать');
  assert.ok(
    машина === -1 || гейт < машина,
    'проверка «мы в браузере» стоит после запуска машины голоса — ограничение снова превратится в «неверный формат WAV»',
  );
  assert.match(body, /showToast\(/, 'браузер молчит про ограничение — выглядит как сломанная клавиша');
});

test('очередь промптов подхватывается при подключении к живой вкладке', () => {
  // B9: клиент собирает очередь только из событий queue:changed, а
  // подключившийся к уже живым вкладкам ни одного не застал — видел пустую
  // строку чипов там, где реально ждут промпты, и добавлял их повторно.
  const body = topLevelBody(APP_JS, 'async function attachTab(');
  assert.match(
    body,
    /queueByTab\.set\(t\.tabId/,
    'подключение больше не берёт очередь из списка вкладок — после перезагрузки страницы чипы снова пропадут',
  );
  // Гонка, найденная ревью фикса: снимок посчитан одним tabs:list на весь
  // пакет, а подключаемся по очереди — пришедший тем временем queue:changed
  // свежее снимка.
  assert.match(
    body,
    /!queueByTab\.has\(t\.tabId\)/,
    'снимок очереди перезатирает более свежее зеркало, пришедшее событием',
  );
});

test('после закрытия оверлеев фокус уводится из-под заглушки', () => {
  // Находка ревью фикса B4: каждый из закрываемых оверлеев на закрытии
  // возвращает фокус в терминал, то есть отменяет парковку, сделанную
  // renderCurtain мгновением раньше. Человек оказывался печатающим вслепую
  // под заглушкой, а кнопка «Забрать управление» теряла фокус — Enter больше
  // не возвращал руль.
  const park = topLevelBody(APP_JS, 'function parkFocusOnCurtain(');
  assert.match(park, /blur\?\.\(\)/, 'парковка перестала снимать фокус с того, что под заглушкой');
  assert.match(park, /take\.focus\(\)/, 'парковка перестала ставить фокус на кнопку захвата');

  const curtain = topLevelBody(APP_JS, 'function renderCurtain(');
  assert.match(curtain, /parkFocusOnCurtain\(\)/, 'появление заглушки больше не паркует фокус');
});
