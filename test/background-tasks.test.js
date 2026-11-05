'use strict';
// Фоновые задачи вкладки (src/main/background-tasks.js) — чистые функции.
//
// Фикстуры — РЕАЛЬНОЙ формы. tool_response для Bash/Agent — как в журнале
// сессии Claude Code 2.1.318 (план 2026-11-05, таблица «Откуда данные»).
// background_tasks у Stop — по схеме хука того же бинаря (поля id/type/
// status/description + command у shell, agent_type у subagent; type —
// «дружелюбная» метка: local_bash → 'shell', local_agent → 'subagent').

const test = require('node:test');
const assert = require('node:assert');
const {
  launchedTaskId, liveBackground, backgroundSubtitle, isTaskNotification,
} = require('../src/main/background-tasks');

// --- реальные payload'ы PostToolUse ---

const BASH_BG = {
  tool_name: 'Bash',
  tool_input: { command: 'dd if=img of=/dev/sdb bs=4M', description: 'Запись образа', run_in_background: true },
  tool_response: {
    stdout: '', stderr: '', interrupted: false, isImage: false, backgroundTaskId: 'btlnghtdk',
  },
};
const AGENT_ASYNC = {
  tool_name: 'Agent',
  tool_input: { description: 'Ревью ветки', prompt: '...', run_in_background: true },
  tool_response: {
    isAsync: true,
    status: 'async_launched',
    agentId: 'a12f8ef3df5eb51b4',
    description: 'Ревью ветки',
    prompt: '...',
    outputFile: 'C:\\Users\\x\\AppData\\Local\\Temp\\claude\\p\\s\\tasks\\a12f8ef3df5eb51b4.output',
  },
};

// --- launchedTaskId ---

test('launchedTaskId: фоновая команда Bash → id из backgroundTaskId, вид shell', () => {
  assert.deepStrictEqual(
    launchedTaskId(BASH_BG.tool_name, BASH_BG.tool_response),
    { id: 'btlnghtdk', kind: 'shell' },
  );
});

test('launchedTaskId: PowerShell в фоне — тоже команда', () => {
  assert.deepStrictEqual(
    launchedTaskId('PowerShell', { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b7g5591zl' }),
    { id: 'b7g5591zl', kind: 'shell' },
  );
});

test('launchedTaskId: команда, уведённая в фон по Ctrl+B или по таймауту, — тоже фон (run_in_background в input нет)', () => {
  // backgroundTaskId CLI ставит ровно тогда, когда команда продолжает жить в
  // фоне, — каким бы путём она туда ни попала.
  assert.deepStrictEqual(
    launchedTaskId('Bash', { stdout: 'начало вывода', stderr: '', interrupted: false, backgroundTaskId: 'bj529d94c', backgroundedByUser: true }),
    { id: 'bj529d94c', kind: 'shell' },
  );
  assert.deepStrictEqual(
    launchedTaskId('Bash', { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'by3b2zf6d', timedOutAfterMs: 120000 }),
    { id: 'by3b2zf6d', kind: 'shell' },
  );
});

test('launchedTaskId: обычная (не фоновая) команда — не фон', () => {
  assert.strictEqual(launchedTaskId('Bash', { stdout: 'ok', stderr: '', interrupted: false }), null);
});

test('launchedTaskId: команда, которую CLI снимет на финальном ответе, — не фон хода', () => {
  // backgroundEndsWithFinalResponse: CLI сам завершает её вместе с ответом и
  // уведомления не шлёт — держать вкладку в «Работают» ради неё нельзя.
  assert.strictEqual(
    launchedTaskId('Bash', { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b91mw8h9l', backgroundEndsWithFinalResponse: true }),
    null,
  );
});

test('launchedTaskId: фоновый агент → id из agentId, вид agent', () => {
  assert.deepStrictEqual(
    launchedTaskId(AGENT_ASYNC.tool_name, AGENT_ASYNC.tool_response),
    { id: 'a12f8ef3df5eb51b4', kind: 'agent' },
  );
});

test('launchedTaskId: синхронный агент (ход ждёт его сам) — не фон', () => {
  assert.strictEqual(
    launchedTaskId('Agent', { status: 'completed', agentId: 'a9045d232245cb70d', content: [{ type: 'text', text: 'готово' }] }),
    null,
  );
});

test('launchedTaskId: SendMessage возобновил агента → снова фон', () => {
  assert.deepStrictEqual(
    launchedTaskId('SendMessage', { success: true, message: 'Resuming agent reviewer', resumedAgentId: 'a36a360401b5c5769', revivedAgentId: 'a36a360401b5c5769' }),
    { id: 'a36a360401b5c5769', kind: 'agent' },
  );
  assert.strictEqual(launchedTaskId('SendMessage', { success: false, message: 'not reachable' }), null);
});

// Форма ответа Workflow — из бинаря 2.1.318: {status:'async_launched', taskId,
// taskType:'local_workflow', workflowName, runId, summary, transcriptDir,
// scriptPath}; при ошибке компиляции сценария — то же плюс error.
const WORKFLOW_ASYNC = {
  status: 'async_launched',
  taskId: 'wq8n3m2kd',
  taskType: 'local_workflow',
  workflowName: 'spec',
  runId: 'wf_1a2b3c4d5e6f',
  summary: 'Разбор документов волнами',
  transcriptDir: 'C:\\Users\\x\\.claude\\projects\\p\\S1\\workflows\\wf_1a2b3c4d5e6f',
  scriptPath: 'C:\\Users\\x\\.claude\\projects\\p\\S1\\workflows\\spec.js',
};

test('launchedTaskId: фоновый Workflow → id из taskId, вид workflow', () => {
  assert.deepStrictEqual(launchedTaskId('Workflow', WORKFLOW_ASYNC), { id: 'wq8n3m2kd', kind: 'workflow' });
});

test('launchedTaskId: Workflow со сломанным сценарием или удалённый — не фон', () => {
  // error — сценарий не скомпилировался, задача не живёт; remote_launched —
  // запуск в облаке, вне этой машины.
  assert.strictEqual(launchedTaskId('Workflow', { ...WORKFLOW_ASYNC, error: 'SyntaxError: Unexpected token' }), null);
  assert.strictEqual(launchedTaskId('Workflow', { ...WORKFLOW_ASYNC, status: 'remote_launched', taskType: 'remote_agent' }), null);
  // Схема допускает и такое сочетание; локальным воркфлоу CLI его не считает.
  assert.strictEqual(launchedTaskId('Workflow', { ...WORKFLOW_ASYNC, taskType: 'remote_agent' }), null);
  // Операция над уже идущим прогоном (runId в запросе): бинарь отвечает
  // {status: RUN_OP_STATUS, taskId: '', runId, runOp} — это не новый фон.
  assert.strictEqual(launchedTaskId('Workflow', { status: 'run_op', taskId: '', runId: 'wf_1a2b3c4d5e6f', runOp: 'stop' }), null);
  assert.strictEqual(launchedTaskId('Workflow', { ...WORKFLOW_ASYNC, taskId: '' }), null);
});

test('launchedTaskId: Monitor и прочие инструменты не считаются, даже с похожими полями', () => {
  // Настоящий ответ Monitor — {taskId, timeoutMs}.
  assert.strictEqual(launchedTaskId('Monitor', { taskId: 'bmon12345', timeoutMs: 600000 }), null);
  assert.strictEqual(launchedTaskId('Monitor', { taskId: 'bmon12345', backgroundTaskId: 'bmon12345' }), null);
  assert.strictEqual(launchedTaskId('TaskStop', { task_id: 'btlnghtdk' }), null);
  assert.strictEqual(launchedTaskId('Read', { file: { content: '' } }), null);
});

test('launchedTaskId: мусор на входе не роняет', () => {
  assert.strictEqual(launchedTaskId('Bash', null), null);
  assert.strictEqual(launchedTaskId('Bash', undefined), null);
  assert.strictEqual(launchedTaskId('Bash', 'строка вместо объекта'), null);
  assert.strictEqual(launchedTaskId('Bash', { backgroundTaskId: '' }), null);
  assert.strictEqual(launchedTaskId('Bash', { backgroundTaskId: 42 }), null);
  assert.strictEqual(launchedTaskId('Agent', { isAsync: true, agentId: '' }), null);
  assert.strictEqual(launchedTaskId(undefined, BASH_BG.tool_response), null);
});

// --- liveBackground ---

const known = () => new Map([['btlnghtdk', 'shell'], ['a12f8ef3df5eb51b4', 'agent']]);

test('liveBackground: оставляет только то, что CLI на Stop назвал живым', () => {
  const live = liveBackground(known(), [
    {
      id: 'btlnghtdk', type: 'shell', status: 'running', description: 'Запись образа', command: 'dd if=img of=/dev/sdb bs=4M',
    },
  ]);
  assert.deepStrictEqual([...live], [['btlnghtdk', 'shell']]);
});

test('liveBackground: пустой список у Stop — фон кончился, даже если уведомление пришло посреди хода', () => {
  // Уведомление о конце задачи CLI часто вкладывает прямо в идущий ход, и
  // хук UserPromptSubmit его не видит. Список Stop — единственный, кто знает.
  assert.strictEqual(liveBackground(known(), []).size, 0);
});

test('liveBackground: живое, но не запущенное нами (Monitor и т.п.), не считается', () => {
  // Monitor в списке Stop выглядит как type 'shell' (local_bash kind monitor),
  // отличить его можно только по тому, что мы не видели его запуска.
  const live = liveBackground(known(), [
    { id: 'bmon12345', type: 'shell', status: 'running', description: 'ждёт сборку', command: 'until ...' },
    { id: 'a12f8ef3df5eb51b4', type: 'subagent', status: 'running', description: 'Ревью', agent_type: 'general-purpose' },
  ]);
  assert.deepStrictEqual([...live], [['a12f8ef3df5eb51b4', 'agent']]);
});

test('liveBackground: CLI без поля background_tasks — null (знать нечем)', () => {
  assert.strictEqual(liveBackground(known(), undefined), null);
  assert.strictEqual(liveBackground(known(), null), null);
  assert.strictEqual(liveBackground(known(), 'running'), null);
});

test('liveBackground: мусорные элементы списка пропускаются, вход не мутируется', () => {
  const bg = known();
  const live = liveBackground(bg, [null, 42, {}, { id: 7 }, { id: 'btlnghtdk', type: 'shell', status: 'pending', description: '' }]);
  assert.deepStrictEqual([...live], [['btlnghtdk', 'shell']]);
  assert.strictEqual(bg.size, 2, 'исходная карта не должна меняться');
});

// --- backgroundSubtitle ---

const shells = (n) => new Map(Array.from({ length: n }, (_, i) => [`b${i}`, 'shell']));
const agents = (n) => new Map(Array.from({ length: n }, (_, i) => [`a${i}`, 'agent']));

test('backgroundSubtitle: русская множественность для команд', () => {
  assert.strictEqual(backgroundSubtitle(shells(1)), 'фон · 1 команда');
  assert.strictEqual(backgroundSubtitle(shells(2)), 'фон · 2 команды');
  assert.strictEqual(backgroundSubtitle(shells(4)), 'фон · 4 команды');
  assert.strictEqual(backgroundSubtitle(shells(5)), 'фон · 5 команд');
  assert.strictEqual(backgroundSubtitle(shells(11)), 'фон · 11 команд');
  assert.strictEqual(backgroundSubtitle(shells(12)), 'фон · 12 команд');
  assert.strictEqual(backgroundSubtitle(shells(14)), 'фон · 14 команд');
  assert.strictEqual(backgroundSubtitle(shells(21)), 'фон · 21 команда');
  assert.strictEqual(backgroundSubtitle(shells(22)), 'фон · 22 команды');
  assert.strictEqual(backgroundSubtitle(shells(25)), 'фон · 25 команд');
  assert.strictEqual(backgroundSubtitle(shells(111)), 'фон · 111 команд');
});

test('backgroundSubtitle: русская множественность для агентов', () => {
  assert.strictEqual(backgroundSubtitle(agents(1)), 'фон · 1 агент');
  assert.strictEqual(backgroundSubtitle(agents(2)), 'фон · 2 агента');
  assert.strictEqual(backgroundSubtitle(agents(5)), 'фон · 5 агентов');
  assert.strictEqual(backgroundSubtitle(agents(11)), 'фон · 11 агентов');
  assert.strictEqual(backgroundSubtitle(agents(21)), 'фон · 21 агент');
  assert.strictEqual(backgroundSubtitle(agents(22)), 'фон · 22 агента');
});

test('backgroundSubtitle: команды и агенты вместе — сначала команды', () => {
  const mixed = new Map([['a1', 'agent'], ['b1', 'shell']]);
  assert.strictEqual(backgroundSubtitle(mixed), 'фон · 1 команда, 1 агент');
  const more = new Map([['b1', 'shell'], ['b2', 'shell'], ['a1', 'agent'], ['a2', 'agent'], ['a3', 'agent'], ['a4', 'agent'], ['a5', 'agent']]);
  assert.strictEqual(backgroundSubtitle(more), 'фон · 2 команды, 5 агентов');
});

test('backgroundSubtitle: workflow — после команд и агентов, слово не склоняется', () => {
  assert.strictEqual(backgroundSubtitle(new Map([['w1', 'workflow']])), 'фон · 1 workflow');
  const all = new Map([['w1', 'workflow'], ['a1', 'agent'], ['w2', 'workflow'], ['b1', 'shell']]);
  assert.strictEqual(backgroundSubtitle(all), 'фон · 1 команда, 1 агент, 2 workflow');
});

test('backgroundSubtitle: пустой фон — пустая подпись', () => {
  assert.strictEqual(backgroundSubtitle(new Map()), '');
});

// --- isTaskNotification ---

test('isTaskNotification: ход, начатый уведомлением о конце задачи, — да', () => {
  const prompt = '<task-notification>\n<task-id>a12f8ef3df5eb51b4</task-id>\n<tool-use-id>toolu_01AgentLaunch</tool-use-id>\n'
    + '<output-file>C:\\Users\\x\\AppData\\Local\\Temp\\claude\\p\\S1\\tasks\\a12f8ef3df5eb51b4.output</output-file>\n'
    + '<status>completed</status>\n<summary>Agent "Ревью ветки" completed</summary>\n</task-notification>';
  assert.strictEqual(isTaskNotification(prompt), true);
  assert.strictEqual(isTaskNotification(`\n  ${prompt}`), true);
});

test('isTaskNotification: обычный промпт человека — нет, даже если упоминает тег', () => {
  assert.strictEqual(isTaskNotification('почему <task-notification> не пришёл?'), false);
  assert.strictEqual(isTaskNotification('запиши образ на флешку'), false);
  assert.strictEqual(isTaskNotification(''), false);
  assert.strictEqual(isTaskNotification(undefined), false);
  assert.strictEqual(isTaskNotification(42), false);
});
