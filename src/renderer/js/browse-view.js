'use strict';
// Решения файлового обзора, отделённые от DOM: крошки, пометка занятых папок,
// недавние, чистка введённого пути. Renderer под node --test не идёт, поэтому
// всё, что можно испортить незаметно, живёт здесь и проверяется напрямую.
//
// Пути только Windows-вида: кокпит запускается на Windows, а обзор всегда
// показывает файловую систему МАШИНЫ С КОКПИТОМ, даже когда смотрят с макбука.

const SEP = '\\';

// 'C:\\Users\\Lunev' → [{name:'C:',path:'C:\\'}, {name:'Users',…}, …]
export function crumbs(dirPath) {
  if (typeof dirPath !== 'string' || !dirPath.trim()) return [];
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
function samePath(a, b) {
  const norm = (p) => String(p || '').replace(/[/\\]+$/, '').replace(/\//g, SEP).toLowerCase();
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
