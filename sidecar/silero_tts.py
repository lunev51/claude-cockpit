"""Silero TTS sidecar (v4_ru).

Долгоживущий процесс: грузит модель один раз, читает построчно JSON из stdin,
синтезирует речь, пишет WAV во временный файл и печатает результат в stdout.

Протокол (по строке на сообщение):
  stdin  : {"id": N, "text": "...", "speaker": "baya", "sample_rate": 48000}
  stdout : {"ready": true}                          — однократно при старте
           {"id": N, "wav": "<path>"}               — успех
           {"id": N, "error": "..."}                — ошибка синтеза
Логи и трейсбеки идут в stderr.
"""

import json
import os
import sys
import tempfile
import traceback


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def load_model():
    import torch

    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(here)
    model_path = os.path.join(root, "models", "tts", "v4_ru.pt")
    if not os.path.exists(model_path):
        raise FileNotFoundError("Не найдена модель Silero: " + model_path)

    torch.set_num_threads(max(1, (os.cpu_count() or 2) // 2))
    importer = torch.package.PackageImporter(model_path)
    model = importer.load_pickle("tts_models", "model")
    model.to("cpu")
    return model


def write_wav(audio, sample_rate, path):
    import wave
    import torch

    # audio — 1-D torch.Tensor float [-1, 1]; конвертируем в 16-bit PCM mono.
    tensor = audio if isinstance(audio, torch.Tensor) else torch.tensor(audio)
    tensor = tensor.detach().to("cpu").clamp(-1.0, 1.0)
    pcm = (tensor * 32767.0).to(torch.int16).numpy().tobytes()
    with wave.open(path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(int(sample_rate))
        wf.writeframes(pcm)


def main():
    try:
        model = load_model()
    except Exception as exc:  # noqa: BLE001
        log("FATAL load: " + repr(exc))
        log(traceback.format_exc())
        emit({"ready": False, "error": str(exc)})
        return 1

    emit({"ready": True})
    log("silero: model ready")

    for line in sys.stdin:
        # Срезаем возможный BOM и пробелы.
        line = line.lstrip("﻿").strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as exc:  # noqa: BLE001
            log("bad json: " + repr(exc))
            continue

        rid = req.get("id")
        text = req.get("text") or ""
        speaker = req.get("speaker") or "baya"
        sample_rate = int(req.get("sample_rate") or 48000)

        try:
            audio = model.apply_tts(
                text=text,
                speaker=speaker,
                sample_rate=sample_rate,
            )
            out = os.path.join(tempfile.gettempdir(), "cc-tts-{}.wav".format(rid))
            write_wav(audio, sample_rate, out)
            emit({"id": rid, "wav": out})
        except Exception as exc:  # noqa: BLE001
            log("synth error id={}: {}".format(rid, repr(exc)))
            log(traceback.format_exc())
            emit({"id": rid, "error": str(exc)})

    return 0


if __name__ == "__main__":
    sys.exit(main())
