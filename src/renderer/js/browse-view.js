'use strict';
// Решения файлового обзора, отделённые от DOM: крошки, пометка занятых папок,
// недавние, чистка введённого пути. Renderer под node --test не идёт, поэтому
// всё, что можно испортить незаметно, живёт здесь и проверяется напрямую.
//
// Пути только Windows-вида: кокпит запускается на Windows, а обзор всегда
// показывает файловую систему МАШИНЫ С КОКПИТОМ, даже когда смотрят с макбука.

const SEP = '\\';

// Сетевой путь UNC (\\сервер\шара) нельзя резать как обычный: первые два
// сегмента — не «папки», а адрес шары, и по отдельности они не значат ничего.
// I4 ревью: без этого первая крошка вела в 'srv\', который разрешался
// относительно рабочей папки главного процесса кокпита, то есть уводила в
// постороннее место. Попасть на UNC можно прямо из строки ввода —
// normalizeInput('//srv/share') честно даёт '\\srv\share'.
// Имя шары необязательно: '\\srv' — нормальный первый шаг, в проводнике так
// смотрят список шар сервера. I-2 ре-ревью: раньше эта форма не подходила под
// «два сегмента», уходила в обычную ветку и давала крошку 'srv\', а
// path.resolve('srv\') разрешает её ОТНОСИТЕЛЬНО рабочей папки главного
// процесса кокпита — то есть содержимое локальной папки показывалось как
// содержимое сервера, вместе с кнопкой «Открыть сессию здесь».
//
// Возвращаем и корень, и сколько символов он занял В ИСХОДНОЙ строке: считать
// срез по длине нормализованного корня нельзя, сдвоенный разделитель внутри
// ('\\srv\\share') сдвигал бы его и рождал лишнюю крошку (M-2 ре-ревью).
function uncRoot(dirPath) {
  const m = String(dirPath).match(/^[/\\]{2}([^/\\]+)(?:[/\\]+([^/\\]+))?/);
  if (!m) return null;
  const root = m[2]
    ? `${SEP}${SEP}${m[1]}${SEP}${m[2]}`
    : `${SEP}${SEP}${m[1]}`;
  return { root, matched: m[0].length };
}

// 'C:\\Users\\Lunev' → [{name:'C:',path:'C:\\'}, {name:'Users',…}, …]
export function crumbs(dirPath) {
  if (typeof dirPath !== 'string' || !dirPath.trim()) return [];

  const unc = uncRoot(dirPath);
  if (unc) {
    // Корень шары (или сам сервер) — одна неделимая крошка, дальше обычные
    // сегменты. Срез по matched, а не по длине корня: в исходной строке могли
    // быть сдвоенные разделители.
    const rest = dirPath.slice(unc.matched).replace(/[/\\]+$/, '').split(/[/\\]+/).filter(Boolean);
    const out = [{ name: unc.root, path: unc.root }];
    let acc = unc.root;
    for (const part of rest) {
      acc = `${acc}${SEP}${part}`;
      out.push({ name: part, path: acc });
    }
    return out;
  }

  const parts = dirPath.replace(/[/\\]+$/, '').split(/[/\\]+/).filter(Boolean);
  if (!parts.length) return [];
  const out = [{ name: parts[0], path: `${parts[0]}${SEP}` }];
  let acc = parts[0];
  for (const part of parts.slice(1)) {
    acc = `${acc}${SEP}${part}`;
    out.push({ name: part, path: acc });
  }
  return out;
}

// Windows не различает регистр путей, а хвостовой разделитель ничего не значит —
// сравнивать «как есть» означало бы не пометить половину совпадений.
//
// I3 ревью: повторяющиеся разделители тоже надо схлопывать. В корне диска
// склейка `${currentPath}\${name}` даёт 'C:\\games' (два слеша), и пометка
// «здесь уже открыта вкладка» не срабатывала — а корень диска это штатная
// точка входа, слева есть панель «Диски». Ведущие два слеша UNC при этом
// обязаны уцелеть, иначе \\srv\share превратится в \srv\share.
function samePath(a, b) {
  const norm = (p) => {
    const s = String(p || '').replace(/\//g, SEP);
    const lead = s.startsWith(`${SEP}${SEP}`) ? `${SEP}${SEP}` : '';
    return lead + s.slice(lead.length).replace(/\\{2,}/g, SEP).replace(/\\+$/, '').toLowerCase();
  };
  return norm(a) === norm(b);
}

export function markOpen(entries, currentPath, openCwds) {
  const opened = Array.isArray(openCwds) ? openCwds : [];
  return (Array.isArray(entries) ? entries : []).map((e) => ({
    ...e,
    // Файл открытой вкладкой быть не может — пометка только для папок.
    open: !!e.dir && opened.some((cwd) => samePath(cwd, `${currentPath}${SEP}${e.name}`)),
  }));
}

// Недавние: сначала папки живых вкладок (самое свежее, что человек трогал),
// потом папки из сохранённых воркспейсов. Повторы убираем — список короткий,
// и одно и то же имя дважды в нём выглядит поломкой.
export function recentFolders({ tabs, workspaces, limit = 8 } = {}) {
  const paths = [];
  for (const t of Array.isArray(tabs) ? tabs : []) {
    if (t && typeof t.cwd === 'string' && t.cwd.trim()) paths.push(t.cwd);
  }
  for (const w of Array.isArray(workspaces) ? workspaces : []) {
    for (const t of (w && Array.isArray(w.tabs)) ? w.tabs : []) {
      if (t && typeof t.cwd === 'string' && t.cwd.trim()) paths.push(t.cwd);
    }
  }
  const seen = new Set();
  const out = [];
  for (const p of paths) {
    const key = p.replace(/[/\\]+$/, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const parts = p.replace(/[/\\]+$/, '').split(/[/\\]+/).filter(Boolean);
    out.push({ path: p, label: parts[parts.length - 1] || p });
    if (out.length >= limit) break;
  }
  return out;
}

// Путь, скопированный из проводника, приезжает в кавычках и с пробелами по
// краям; путь из браузера на макбуке — со слешами в другую сторону.
export function normalizeInput(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/^"+|"+$/g, '').trim();
  if (!trimmed) return null;
  return trimmed.replace(/\//g, SEP);
}
