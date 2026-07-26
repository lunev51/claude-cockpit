# Локальный голосовой стек (офлайн, русский) — заметки по установке

Дата: 2026-06-10. Платформа: Windows 10 x64, AMD Ryzen 5 5600 (AVX2 есть), Python 3.14.5 (+ uv-managed 3.12.13).
Всё ниже проверено и работает офлайн (интернет нужен был только для скачивания).

## 1. STT — whisper.cpp

### Что скачано
| Что | Куда | Версия / размер |
|---|---|---|
| whisper.cpp Windows x64 (официальный релиз `whisper-bin-x64.zip`) | `vendor\whisper\` (`whisper-cli.exe`, `whisper-server.exe`, `whisper-stream.exe`, `ggml*.dll`, `whisper.dll`, `SDL2.dll` и пр.) | **v1.8.6** (последний релиз, zip 4.0 МБ) |
| Модель `ggml-small.bin` | `models\whisper\ggml-small.bin` | 487 601 967 байт (~465 МБ), с huggingface.co/ggerganov/whisper.cpp |

### Совместимость с CPU
Официальный пребилд собран под AVX/AVX2. На Ryzen 5 5600 (Zen 3, AVX2+FMA+F16C) работает.
На CPU без AVX2 (до ~2013 г.) может падать молча — для нашего железа неактуально.

### Проверенная команда транскрипции (русский)
```cmd
vendor\whisper\whisper-cli.exe -m models\whisper\ggml-small.bin -l ru -t 6 ^
  -f input.wav --no-timestamps --no-prints
```
- Чистый текст уходит в **stdout** (флаг `--no-prints` убирает служебный вывод; технические логи идут в stderr).
- Альтернативно файл: добавить `--output-txt -of out` → `out.txt`; есть `--output-json` (`-oj`) для JSON с сегментами.
- Вход: **необязательно** строго WAV 16kHz mono — v1.8.6 декодирует wav/mp3/flac/ogg через miniaudio и ресемплит сам (проверено на 22050 Hz WAV). Но для предсказуемости из Electron лучше писать WAV 16kHz mono 16-bit.
- Полезные флаги: `-t N` потоки (у нас 6 физ. ядер), `--vad` + `-vm <silero-vad.bin>` для отсечки тишины, `--prompt "..."` для контекста.

### Проверка (round-trip тест)
Синтезированная Piper'ом фраза «Привет, я твой голосовой помощник.» распознана **дословно**.
Время: ~2.5 с целиком (включая ~1.5 с загрузки модели) на 2.9 с аудио, 6 потоков.
Для интерактива лучше держать процесс живым через `whisper-server.exe` (HTTP на localhost) — модель грузится один раз.

## 2. TTS — выбор движка

### Разведка (без тяжёлых установок)
1. **torch под Python 3.14**: вопреки ожиданиям, **wheels есть** — `torch-2.12.0-cp314-cp314-win_amd64.whl`, причём CPU-wheel всего **117 МБ** (не 2+ ГБ — это размер CUDA-сборок под Linux). Т.е. Silero на системном Python 3.14 технически возможен. Запасной вариант (uv-Python 3.12.13) тоже на машине есть.
2. **Silero ONNX без torch**: по `models.yml` репозитория snakers4/silero-models ONNX-модели существуют **только для STT** (en/de/es/ua). Все русские TTS (v3_1_ru, v4_ru, v5_ru с голосами baya/kseniya/...) распространяются только как `.pt` torch.package — **официального ONNX для русского TTS нет**, путь «onnxruntime без torch» отпадает (есть лишь неофициальные конверсии сомнительной поддержки).
3. **Piper TTS**: готовый Windows-бинарник, ноль Python, ONNX Runtime внутри. Скачан и проверен — см. ниже.

### Что скачано (Piper)
| Что | Куда | Версия / размер |
|---|---|---|
| Piper (`piper_windows_amd64.zip`, rhasspy/piper) | `vendor\piper\` (`piper.exe`, `onnxruntime.dll`, `espeak-ng.dll`, `espeak-ng-data\`) | **1.2.0** (релиз 2023.11.14-2, zip 22.5 МБ) |
| Русский голос (женский) | `models\tts\ru_RU-irina-medium.onnx` + `.onnx.json` | 63.2 МБ, huggingface rhasspy/piper-voices, 22050 Hz mono |

### Проверенная команда синтеза
```cmd
echo Привет, я твой голосовой помощник. | vendor\piper\piper.exe ^
  --model models\tts\ru_RU-irina-medium.onnx --output_file out.wav
```
- Текст подаётся в **stdin (UTF-8!)** — из Node писать в stdin байты UTF-8, не через cp1251-консоль.
- Проверено: WAV 138 912 байт, 2.95 с аудио за **0.18 с** инференса (RTF 0.06).
- Потоковый режим: `--output_raw` льёт raw PCM s16le 22050 Hz в stdout — можно играть сразу, не дожидаясь конца. `--json-input` принимает построчно JSON `{"text": "..."}` — процесс держится живым, синтез фраз по очереди без перезагрузки модели.

### Рекомендация
**Основной движок — Piper (ru_RU-irina-medium).** Аргументы:
- ноль зависимостей (нет Python в проде вообще), один exe + 63 МБ модель;
- скорость RTF 0.06 на CPU — мгновенный отклик;
- режим долгоживущего процесса с `--json-input`/`--output_raw` идеально ложится на сайдкар;
- качество medium-голоса «irina» вполне разборчивое и приятное для ассистента.

**Silero (baya/kseniya) — опциональный апгрейд качества**, теперь реально доступный: torch cp314 CPU = 117 МБ + модель v4_ru.pt ~50 МБ в venv. Голоса Silero заметно естественнее по интонации. Делать только если irina покажется «роботизированной». Если делать — брать v4_ru (стабильный API: `model.apply_tts(text=..., speaker='baya', sample_rate=48000)`), venv на системном 3.14 или uv-3.12.13.
Другие piper-голоса ru на пробу: `ru_RU-dmitri-medium` (муж.), `ru_RU-ruslan-medium` (муж.), у irina она единственная женская в ru_RU.

## 3. План интеграции (сайдкар для Electron)

Сайдкар — отдельный child-process (Node-скрипт или сразу spawn бинарников из main-процесса), JSON Lines протокол через stdin/stdout:

```
→ {"id":1,"cmd":"stt","wav":"C:\\tmp\\rec.wav"}
← {"id":1,"ok":true,"text":"привет как дела"}
→ {"id":2,"cmd":"tts","text":"Привет!","play":true}
← {"id":2,"ok":true,"wav":"C:\\tmp\\tts-2.wav","ms":180}
← {"event":"error","detail":"..."}        // асинхронные ошибки
```

Реализация:
- **STT**: вариант А (просто) — spawn `whisper-cli.exe ... --no-prints`, читать stdout. Вариант Б (быстро) — держать `whisper-server.exe -m ... -l ru` на `127.0.0.1:<port>` и слать WAV POST'ом; модель в памяти, отклик < 1 с.
- **TTS**: держать `piper.exe --json-input --output_raw` живым; писать `{"text":...}\n` в stdin, читать PCM из stdout и играть через Web Audio (AudioContext, 22050 Hz s16le) или сохранять WAV.
- **Запись микрофона**: в renderer через `getUserMedia` → WAV 16kHz mono (или MediaRecorder→webm и декодировать, но проще писать WAV сразу).
- Пути к бинарникам/моделям — относительные от app root: `vendor/...`, `models/...`; в проде учесть `process.resourcesPath` (asar unpack для exe/dll/onnx).

## 4. Открытые риски
1. **Кодировка stdin для piper** — обязательно UTF-8 байты; при запуске через cmd echo на cp1251 текст ломается (из Node `child.stdin.write(Buffer.from(text,'utf8'))` — ок).
2. **Холодный старт whisper** ~1.5 с на запуск — для диалога нужен server-режим или предзагрузка.
3. **Качество small-модели**: на шумном микрофоне/быстрой речи возможны ошибки; запасной вариант — `ggml-medium.bin` (~1.5 ГБ, медленнее) или включить `--vad` с silero-vad моделью.
4. **AVX2-зависимость пребилдов** — при переносе на другое железо (старые CPU) нужна пересборка; на этой машине ок.
5. **Piper не развивается активно** (rhasspy/piper заморожен, форк OHF-voice/piper1-gpl жив) — но бинарник 1.2.0 самодостаточен и для офлайн-использования это не проблема.
6. **Антивирус/SmartScreen** может тормозить первый запуск exe из vendor — при упаковке приложения подписать или добавить исключение.
7. asar: exe/dll/onnx/bin нельзя класть внутрь asar — настроить `asarUnpack` для `vendor/**` и `models/**`.

## 5. Структура файлов
```
claude-companion\
  vendor\whisper\   whisper-cli.exe, whisper-server.exe, whisper-stream.exe, *.dll  (v1.8.6)
  vendor\piper\     piper.exe, onnxruntime.dll, espeak-ng.dll, espeak-ng-data\      (1.2.0)
  models\whisper\   ggml-small.bin                       (465 МБ)
  models\tts\       ru_RU-irina-medium.onnx (+ .json)    (63 МБ), test_ru.wav — тестовый синтез
  sidecar\          VOICE_SETUP_NOTES.md (этот файл)
```
