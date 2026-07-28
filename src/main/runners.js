'use strict';
// Раннеры внешних CLI (npx/git/gh) + реестр живых дочерних процессов + watchdog
// принудительной уборки дерева (Task 5 carryover фазы 6, п.2 брифа задачи 5
// фазы 7). Вынесено из ipc.js — там это раньше жило вперемешку с Electron-
// проводкой и вообще не тестировалось (ipc.js целиком требует require('electron'),
// который вне настоящего Electron-рантайма отдаёт не объект, а строку пути к
// бинарнику). Модуль ЧИСТЫЙ: execFile инжектируется (в проде — child_process.execFile,
// см. ipc.js), setTimeoutFn/clearTimeoutFn — тоже (по умолчанию глобальные
// setTimeout/clearTimeout) — тесты подставляют фейковый execFile (отдаёт
// EventEmitter с .pid вместо настоящего child_process.ChildProcess) и
// управляемый таймер, реестр/killProcessTree/armKillWatchdog становятся
// полностью детерминированными, без единого настоящего процесса или секунды
// реального ожидания.

// Версия ccusage запинена сознательно (не @latest): скорость (npx не лезет в
// реестр проверять свежую версию при КАЖДОМ вызове), предсказуемость (один и
// тот же формат JSON и здесь, и у клиента) и меньше supply-chain-поверхности.
// Как обновлять: проверить changelog ccusage на breaking changes в формате
// вывода `claude daily/session --json` (см. test/usage-ccusage.test.js —
// normalize() читает конкретные поля), прогнать тесты на реальном выводе
// новой версии, и только потом поднять номер здесь одной строкой.
const CCUSAGE_PACKAGE = 'ccusage@20.0.19';

// Запас времени, на который наш собственный вотчдог должен сработать РАНЬШЕ,
// чем options.timeout самого execFile.
const KILL_WATCHDOG_GUARD_MS = 500;

function createRunners({ execFile, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout }) {
  // Реестр живых дочерних процессов всех трёх раннеров ниже — pid → ChildProcess,
  // который вернул сам execFile(). Нужен по двум причинам:
  //   (а) execFile(..., {shell:true, timeout}) на Windows спавнит cmd.exe,
  //       который сам спавнит РЕАЛЬНЫЙ процесс (node.exe при npx, gh.exe и
  //       т.п.) — это ВНУК, а не прямой child_process. Штатный timeout/kill()
  //       у execFile убивает только cmd.exe; внук остаётся жить осиротевшим.
  //   (б) закрытие приложения (см. ipc.js/disposeSessions → killAllTracked
  //       ниже) должно добить всё, что ещё выполняется в момент выхода.
  // Убираем запись из реестра сами по событию 'exit' — так killAllTracked()
  // всегда видит актуальный набор РЕАЛЬНО ещё живых процессов.
  const liveChildren = new Map();

  function trackChild(child) {
    if (child && typeof child.pid === 'number') {
      liveChildren.set(child.pid, child);
      child.once('exit', () => liveChildren.delete(child.pid));
    }
    return child;
  }

  // Убивает дерево процессов по pid: taskkill /PID <pid> /T /F.
  //
  // ПРАВИЛО ПРОЕКТА: запрет на `taskkill /F` касается ЗАВЕРШЕНИЯ САМОГО
  // ПРИЛОЖЕНИЯ КОКПИТА в тестах и живых проверках — жёсткое убийство электрона
  // мимо его обработчиков выхода прячет баги. К ЭТИМ процессам (headless-
  // помощники runCcusage/gitRun/ghRun — npx/gh/git) это не относится: у них
  // нет состояния, которое нужно сохранить корректным выходом, они headless,
  // и killProcessTree() зовётся ТОЛЬКО когда они уже либо просрочили свой
  // собственный таймаут (killTreeOnTimeout), либо приложение закрывается, а
  // они всё ещё висят — то есть их штатное время уже вышло. `/F` здесь — не
  // обход правила, а его точное применение: для завершения ПОМОЩНИКОВ (не
  // самого кокпита) он разрешён и необходим.
  //
  // Почему обязателен именно `/F`: эмпирически проверено (задача 5 фазы 6) —
  // `taskkill /PID <pid> /T` БЕЗ `/F` на Windows структурно не может закрыть
  // headless-дерево (node.exe/gh.exe/git.exe без своего окна). `/T` —
  // рекурсивно по всему дереву потомков (убивает не только cmd.exe, но и его
  // внука node/gh).
  //
  // Колбэк-заглушка ниже — код возврата/ошибку taskkill сознательно
  // проглатываем: она падает, если процесс уже успел завершиться сам между
  // таймаутом/dispose и этим вызовом (гонка, не баг) — best-effort уборка
  // ПОСЛЕ факта, её неуспех не должен ничего прерывать.
  function killProcessTree(pid) {
    if (typeof pid !== 'number') return;
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
  }

  // Убивает дерево ПО ТАЙМАУТУ (err.killed — execFile сам взвёл SIGTERM/kill,
  // потому что процесс не уложился в options.timeout): по обычному коду
  // завершения (в т.ч. code!=0) дерево трогать не нужно — процесс и так уже
  // закончился сам. ВАЖНО (найдено живой проверкой задачи 5): это ВТОРИЧНЫЙ,
  // подстраховочный вызов — к моменту, когда колбэк execFile вообще
  // срабатывает с err.killed:true, child.pid к этому моменту как правило уже
  // МЁРТВ, и taskkill там его не находит. Основную работу по факту делает
  // armKillWatchdog() ниже — он бьёт по дереву, ПОКА родитель ещё жив.
  function killTreeOnTimeout(err, child) {
    if (err && err.killed) killProcessTree(child.pid);
  }

  // Проактивный вотчдог: форсит ДЕРЕВО по child.pid чуть РАНЬШЕ, чем истечёт
  // options.timeout execFile — единственный способ, которым taskkill реально
  // находит ещё живое дерево (см. комментарий killTreeOnTimeout выше). Сам
  // options.timeout execFile остаётся страховочным бэкстопом; повторный/поздний
  // killProcessTree на уже мёртвый pid безвреден. .unref() — вотчдог не
  // должен сам по себе держать процесс живым.
  function armKillWatchdog(child, timeoutMs) {
    const delay = Math.max(0, timeoutMs - KILL_WATCHDOG_GUARD_MS);
    const timer = setTimeoutFn(() => killProcessTree(child.pid), delay);
    timer.unref?.();
    return timer;
  }

  // run(args) для ccusage: execFile('npx', ...) БЕЗ shell:true падает на
  // Windows с ENOENT (npx — .cmd-шим, не бинарник); shell:true — рабочий
  // вариант (проверено: реальный вызов вернулся с валидным JSON). args —
  // фиксированные литералы вида ['claude','daily','--json'], без
  // пользовательского ввода — риск инъекции через DEP0190 отсутствует.
  function runCcusage(args) {
    return new Promise((resolve) => {
      const TIMEOUT_MS = 60000;
      const child = execFile('npx', ['--yes', CCUSAGE_PACKAGE, ...args], {
        timeout: TIMEOUT_MS,
        windowsHide: true,
        shell: true,
        maxBuffer: 16 * 1024 * 1024,
      }, (err, stdout, stderr) => {
        clearTimeoutFn(watchdog);
        killTreeOnTimeout(err, child);
        resolve({ code: err ? (err.code || 1) : 0, stdout: stdout || '', stderr: stderr || '' });
      });
      trackChild(child);
      const watchdog = armKillWatchdog(child, TIMEOUT_MS);
    });
  }

  // run(args, cwd) для git-info.js: resolve({code, stdout, stderr}) на ЛЮБОЙ
  // обычный запуск (в т.ч. code!=0), REJECT только когда бинарника нет вовсе
  // (ENOENT), чтобы isGitMissingError() в git-info.js отличил «git не
  // установлен» от «git сказал code!=0». maxBuffer 10 МБ — диффы больших
  // коммитов легко превышают мегабайт. timeout 15с.
  function gitRun(args, cwd) {
    return new Promise((resolve, reject) => {
      const TIMEOUT_MS = 15000;
      const child = execFile('git', args, {
        cwd, windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024,
      }, (err, stdout, stderr) => {
        clearTimeoutFn(watchdog);
        killTreeOnTimeout(err, child);
        if (err && err.code === 'ENOENT') {
          reject(err);
          return;
        }
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        resolve({ code, stdout: stdout || '', stderr: stderr || '' });
      });
      trackChild(child);
      const watchdog = armKillWatchdog(child, TIMEOUT_MS);
    });
  }

  // run(args, cwd) для gh-info.js: тот же контракт, что и gitRun выше.
  // shell:true ОБЯЗАТЕЛЕН на Windows — без него execFile('gh', ...) падает с
  // ENOENT, если gh.exe обёрнут батником/шимом (тот же приём, что у npx в
  // runCcusage выше — тот же класс проблемы на этой платформе). cwd не
  // всегда нужен вызывающему коду (getGlobal() зовёт execGh без cwd вовсе) —
  // execFile с cwd:undefined просто использует cwd текущего процесса.
  // timeout 30с (дольше gitRun) — search/api — сетевые вызовы, не локальный
  // git. maxBuffer 5 МБ — с запасом под JSON-ответы gh.
  function ghRun(args, cwd) {
    return new Promise((resolve, reject) => {
      const TIMEOUT_MS = 30000;
      const child = execFile('gh', args, {
        cwd, windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: 5 * 1024 * 1024, shell: true,
      }, (err, stdout, stderr) => {
        clearTimeoutFn(watchdog);
        killTreeOnTimeout(err, child);
        if (err && err.code === 'ENOENT') {
          reject(err);
          return;
        }
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        resolve({ code, stdout: stdout || '', stderr: stderr || '' });
      });
      trackChild(child);
      const watchdog = armKillWatchdog(child, TIMEOUT_MS);
    });
  }

  // Добивает ВСЁ, что ещё числится живым в реестре (закрытие приложения,
  // ipc.js/disposeSessions). Снимок ключей в массив ДО цикла: сам taskkill
  // асинхронный, но 'exit' на child может сработать синхронно в тестовых
  // дублёрах — итерация по живой Map во время её же мутации недетерминирована.
  function killAllTracked() {
    for (const pid of [...liveChildren.keys()]) {
      killProcessTree(pid);
    }
  }

  return {
    runCcusage, gitRun, ghRun, killProcessTree, armKillWatchdog, killAllTracked, trackChild, liveChildren,
  };
}

module.exports = { createRunners, CCUSAGE_PACKAGE, KILL_WATCHDOG_GUARD_MS };
