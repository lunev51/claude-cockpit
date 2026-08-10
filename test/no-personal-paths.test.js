'use strict';
// Личные пути не живут в публичном репозитории.
//
// Ревью 09.08 (B8): в дефолтах config.js вторым корнем голосового стека стоял
// `C:\Users\<имя>\AssistClaude\claude-companion` — путь с конкретной машины
// конкретного человека. Репозиторий публичный (MIT), так что это и утечка
// структуры чужого диска, и мёртвая проверка существования у всех остальных.
//
// Машинно-зависимым значениям место в userData/config.user.json — механизм
// оверлея ровно для этого и существует (тот же довод, что у net.host, который
// в дефолтах тоже не прописан).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const SCAN_DIRS = ['src', 'scripts'];
const SCAN_FILES = ['config.json', 'package.json'];

// Домашний каталог конкретного пользователя: C:\Users\кто-то\ или /home/кто-то/
// и /Users/кто-то/ на маке. Сам по себе `C:\Users\` без имени (например, в
// примере пути или в разборе) безвреден — ловим именно ИМЕНОВАННЫЙ каталог.
//
// `\\{1,2}` обязательно: в исходнике на JS путь записан с экранированием
// ('C:\\Users\\кто-то'), и регулярка на одиночный слэш его не видит — первая
// редакция этого стража была именно такой и мутацию «вернуть личный путь»
// пропустила.
const PERSONAL_PATH = /(?:[A-Za-z]:\\{1,2}Users\\{1,2}|\/home\/|\/Users\/)(?!<|\{|\$)[A-Za-z0-9._-]+[\\/]/;

function* scanFiles() {
  for (const dir of SCAN_DIRS) {
    const root = path.join(REPO, dir);
    if (!fs.existsSync(root)) continue;
    const stack = [root];
    while (stack.length) {
      const current = stack.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) { stack.push(full); continue; }
        if (/\.(js|json|html|css)$/.test(entry.name)) yield full;
      }
    }
  }
  for (const name of SCAN_FILES) {
    const full = path.join(REPO, name);
    if (fs.existsSync(full)) yield full;
  }
}

test('в коде нет захардкоженных личных путей', () => {
  const violations = [];
  for (const file of scanFiles()) {
    const rel = path.relative(REPO, file);
    fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
      // Комментарии не трогаем: там пути объясняют поведение (пример UNC,
      // разбор случая с чужой машины) и в поведение программы не попадают.
      const code = line.replace(/^\s*\/\/.*/, '').replace(/\/\/.*$/, '');
      if (PERSONAL_PATH.test(code)) violations.push(`${rel}:${i + 1}: ${code.trim()}`);
    });
  }

  assert.deepStrictEqual(
    violations, [],
    'путь с конкретной машины попал в публичный репозиторий — такому место в config.user.json:\n'
    + violations.join('\n'),
  );
});
