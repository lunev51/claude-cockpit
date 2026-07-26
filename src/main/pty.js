'use strict';
// Обёртка над node-pty. Используем форк с пребилдами —
// на машине нет VS Build Tools, компиляция нативного модуля невозможна.

const { execFileSync } = require('child_process');
const pty = require('@homebridge/node-pty-prebuilt-multiarch');

// Если команда без разделителей пути — резолвим полный путь через where.exe.
// ConPTY надёжнее работает с явным путём к .exe (например,
// claude = C:\Users\Lunev\.local\bin\claude.exe).
function resolveCommand(cmd) {
  if (typeof cmd !== 'string') throw new TypeError('command должен быть строкой');
  if (/[\\/]/.test(cmd)) return cmd; // уже путь — не трогаем
  try {
    // execFileSync без шелла: имя команды не интерпретируется (инъекции/пробелы).
    const out = execFileSync('where.exe', [cmd], { encoding: 'utf8' });
    const lines = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const exe = lines.find((l) => l.toLowerCase().endsWith('.exe'));
    return exe || lines[0] || cmd;
  } catch {
    return cmd; // where не нашёл — пусть pty пробует как есть
  }
}

// Создаёт PTY-процесс и возвращает минимальный интерфейс управления.
function createPty({ command, args = [], cwd, cols, rows, env, onData, onExit, useConpty = true, useConptyDll = true }) {
  const resolved = resolveCommand(command);
  const proc = pty.spawn(resolved, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: env || process.env,
    // Бекенды PTY: системный ConPTY Win10 рисует осиротевшие кириллические
    // глифы при ghost-подсказках Claude Code; winpty не умеет emoji.
    // Решение: ConPTY + НОВЫЙ conpty.dll из пребилда (useConptyDll).
    useConpty,
    useConptyDll: useConpty ? useConptyDll : false,
  });

  if (onData) proc.onData(onData);
  if (onExit) proc.onExit(({ exitCode }) => onExit(exitCode));

  return {
    write: (data) => proc.write(data),
    resize: (cols, rows) => proc.resize(cols, rows),
    kill: () => proc.kill(),
    pid: proc.pid,
  };
}

module.exports = { resolveCommand, createPty };
