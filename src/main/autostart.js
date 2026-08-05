'use strict';
// Чем Windows запускает кокпит при входе. Вынесено из main.js отдельным
// модулем ровно из-за разницы между «собрано» и «разработка»: в проде
// execPath — сам кокпит, в разработке — electron.exe, который без пути к
// проекту поднимет пустое окно Electron и человек решит, что автозапуск сломан.
function buildLoginItem({ packaged, execPath, appRoot }) {
  return {
    path: execPath,
    args: packaged ? ['--hidden'] : [appRoot, '--hidden'],
  };
}

// C3 (ревью): включён ли автозапуск НА САМОМ ДЕЛЕ. Отдельная чистая функция,
// потому что «просто прочитать openAtLogin» на Windows не работает и стоило
// живой фичи: галочка в трее всегда выглядела выключенной, а toggleAutostart
// каждый раз читал false и каждый раз ВКЛЮЧАЛ автозапуск — выключить его из
// меню было физически невозможно.
//
// Что показала проверка ревьюера отдельным Electron-приложением (Electron 29,
// Windows 10), когда запись в HKCU\...\Run ТОЧНО существует:
//   getLoginItemSettings()               -> openAtLogin=false, executableWillLaunchAtLogin=true
//   getLoginItemSettings({path, args})   -> openAtLogin=false   (передача тех же path/args НЕ чинит)
//   сырой реестр: "...electron.exe" C:\...\cockpit --hidden
//   launchItems[0].args: ["C:\\...\\cockpit"]   <-- парсер Electron потерял '--hidden'
// openAtLogin — это результат сравнения ожидаемых args с разобранными, а
// разбор теряет часть аргументов, поэтому сравнение не сходится никогда.
//
// Порядок признаков ниже — от самого честного к самому слабому:
//  1. executableWillLaunchAtLogin (Windows) — «Windows запустит этот exe при
//     входе», причём с учётом деактивации записи через диспетчер задач
//     (StartupApproved). Ровно тот вопрос, который задаёт галочка.
//  2. launchItems — разбор записей Run для нашего исполняемого файла;
//     enabled повторяет ту же деактивацию. Страховка на случай сборки, где
//     первого поля нет.
//  3. openAtLogin — единственный признак на macOS/Linux, где двух первых нет.
function isAutostartOn(settings) {
  if (!settings || typeof settings !== 'object') return false;
  if (typeof settings.executableWillLaunchAtLogin === 'boolean') {
    return settings.executableWillLaunchAtLogin;
  }
  const items = Array.isArray(settings.launchItems) ? settings.launchItems : [];
  if (items.length) return items.some((item) => item && item.enabled === true);
  return settings.openAtLogin === true;
}

module.exports = { buildLoginItem, isAutostartOn };
