'use strict';
// HTTP-приёмник событий хуков Claude Code. Слушает только 127.0.0.1.
// Хук-скрипт (scripts/cockpit-hook.js) POST-ит {event, data, tabId} на /event;
// data — это stdin-JSON хука (session_id, cwd, tool_name, message, …), tabId —
// COCKPIT_TAB_ID из env хук-процесса (null у сторонних claude-сессий).
// Единственный источник правды о статусах — эти события (спека §4.1).
//
// Маршрутизация (приоритет сверху вниз):
//  1. tabId точно известен и это ИЗВЕСТНАЯ мосту вкладка (sessions.has) —
//     адресуем напрямую. Это же покрывает самый первый SessionStart вкладки:
//     привязка происходит по tabId, а не по угадыванию.
//  2. иначе — по data.session_id через sessions.findBySessionId (уже
//     привязанная вкладка сама себя узнаёт по session_id хука).
//  3. иначе — 202: событие не наше (либо чужая внешняя сессия, либо мы его
//     ещё не можем адресовать). cwd-fallback НАМЕРЕННО убран: до фикса он
//     позволял внешней (не-кокпитной) claude-сессии того же проекта — она
//     тоже шлёт хуки и достаёт мост через port-файл — перехватить чужую
//     непривязанную вкладку по совпадению рабочей директории. sessions.js
//     держит findUnboundByCwd экспортированным (Фаза 2b может это переиспользовать
//     иначе), но мост его больше не вызывает никогда.
//
// gen (доп. находка ревью Task 1 фазы 7, задача 5): payload несёт ещё и
// поколение pty, которое породило хук (cockpit-hook.js кладёт туда свой
// COCKPIT_TAB_GEN) — прокидываем его в sessions.applyHookEvent() как есть,
// НЕ решая здесь, актуально оно или нет: это знает только sessions.js
// (у него единственного есть текущий tab.gen). Найденный tabId — вопрос
// адресации (кому вообще послать событие); валидность поколения — вопрос
// применения события внутри уже найденной вкладки, две разные заботы.

const http = require('http');
const fs = require('fs');

function createHookBridge({ sessions, port = 0, portFile = null }) {
  let server = null;
  let actualPort = 0;

  function route(event, data, tabId, gen) {
    let targetTab = null;
    if (typeof tabId === 'string' && sessions.has(tabId)) {
      targetTab = tabId;
    } else if (data.session_id) {
      targetTab = sessions.findBySessionId(data.session_id);
    }
    if (!targetTab) return false;
    sessions.applyHookEvent(targetTab, event, data, gen);
    return true;
  }

  function handler(req, res) {
    if (req.method !== 'POST' || req.url !== '/event') {
      res.writeHead(404).end();
      return;
    }
    // Требуем application/json: браузерный fetch с text/plain (no-cors) отсекается,
    // а на JSON content-type браузер требует CORS-preflight, на который мост не отвечает.
    const ct = String(req.headers['content-type'] || '').toLowerCase();
    if (!ct.startsWith('application/json')) {
      res.writeHead(400, { 'content-type': 'application/json' }).end('{"ok":false}');
      return;
    }
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 256 * 1024) req.destroy(); // защита от мусора
    });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* мусор */ }
      if (!parsed || typeof parsed.event !== 'string') {
        res.writeHead(400, { 'content-type': 'application/json' }).end('{"ok":false}');
        return;
      }
      const data = (parsed.data && typeof parsed.data === 'object') ? parsed.data : {};
      // gen — Number.isInteger отсекает мусор/отсутствие поля (сторонний
      // POST, гипотетический старый хук-скрипт без COCKPIT_TAB_GEN) в null.
      // I4 (ревью финальной волны фазы 7): null здесь — НЕ «гард полностью
      // выключен» (это было бы дырой — сторонний процесс мог бы вбросить
      // очередь в чужой pty через session_id-маршрутизацию выше), а «нет
      // доказательства поколения»: sessions.applyHookEvent() в этом случае
      // всё ещё применяет статус (заявленная фича port-file — сторонние
      // сессии двигают статус), но НЕ даёт побочному эффекту (вброс очереди)
      // случиться без доказанного (числового и совпавшего) gen — подробности
      // и обоснование узкого фикса в sessions.js/applyHookEvent.
      const gen = Number.isInteger(parsed.gen) ? parsed.gen : null;
      let routed = false;
      try { routed = route(parsed.event, data, parsed.tabId, gen); } catch (err) {
        console.warn(`[hook-bridge] ошибка маршрутизации: ${err.message}`);
      }
      res.writeHead(routed ? 200 : 202, { 'content-type': 'application/json' }).end('{"ok":true}');
    });
  }

  function start() {
    return new Promise((resolve, reject) => {
      server = http.createServer(handler);
      server.on('error', reject);
      server.listen(port, '127.0.0.1', () => {
        actualPort = server.address().port;
        if (portFile) {
          try { fs.writeFileSync(portFile, String(actualPort), 'utf8'); } catch (err) {
            console.warn(`[hook-bridge] не записал port-файл: ${err.message}`);
          }
        }
        resolve(actualPort);
      });
    });
  }

  function stop() {
    if (server) {
      try { server.close(); } catch { /* уже */ }
      server = null;
    }
    if (portFile) {
      // FIX 9 (ревью): второй запуск, проигравший requestSingleInstanceLock()
      // в main.js, зовёт app.quit() — но модуль продолжает выполняться дальше
      // синхронно, доходит до before-quit/window-all-closed и до этого stop()
      // тоже. Раньше он безусловно удалял portFile — то есть проигравший
      // инстанс стирал port-файл ЖИВОГО первого инстанса, и внешние
      // claude-сессии теряли доставку хуков в уже работающий Cockpit.
      // Удаляем файл, только если его содержимое всё ещё совпадает с портом,
      // который слушали именно МЫ: если там другое число — значит файл уже
      // переписан реально живым (другим) инстансом, и трогать его нельзя.
      try {
        const contents = fs.readFileSync(portFile, 'utf8').trim();
        if (Number(contents) === actualPort) {
          fs.unlinkSync(portFile);
        }
      } catch { /* нет файла или не прочитать — не страшно */ }
    }
  }

  return { start, stop, port: () => actualPort };
}

module.exports = { createHookBridge };
