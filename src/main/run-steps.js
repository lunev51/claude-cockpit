'use strict';
// Каскад уборки, в котором шаги друг от друга не зависят (ревью 09.08, C25).
//
// disposeSessions и обработчики выхода в main.js были голыми цепочками
// вызовов: исключение в любом звене обрывало всё, что ниже. Самое дорогое,
// что при этом не выполнялось, — manager.disposeAll() и stt.dispose(): живые
// claude.exe и whisper-server переживали кокпит и висели в памяти до ручного
// снятия.
//
// steps — массив [label, fn]. Каждый шаг в своём try/catch; сбой уходит в
// log(label, err), следующие шаги выполняются. Лог тоже в try/catch: на
// выходе вывод процесса уже мог закрыться, и бросивший логгер оборвал бы
// каскад ровно так же, как упавший шаг.
function runSteps(steps, log) {
  for (const [label, fn] of steps) {
    try {
      fn();
    } catch (err) {
      try { log(label, err); } catch { /* лог не важнее уборки */ }
    }
  }
}

module.exports = { runSteps };
