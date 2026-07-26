"""Режим «Юки отвечает за тебя» (когда ушёл офлайн).

  python tg_away.py on "18:00"            — отвечать за тебя до 18:00
  python tg_away.py on "2026-06-12 18:00" — то же, абсолютная дата-время
  python tg_away.py off                   — ты вернулся, больше не отвечать за тебя

Пока режим включён, Юки сама отвечает написавшим; если спросят — скажет, что ты
занят примерно до указанного времени. Не вернёшься к сроку — продлит на час.
"""
import json
import os
import sys
import urllib.error
import urllib.request

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass

SEND_PORT = int(os.environ.get("CC_TG_SEND_PORT", "48754"))


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in ("on", "off"):
        print('Использование: tg_away.py on "ЧЧ:ММ" | tg_away.py off', file=sys.stderr)
        sys.exit(2)
    action = sys.argv[1]
    payload = {"action": action}
    if action == "on":
        if len(sys.argv) < 3:
            print('Для on нужно время: tg_away.py on "18:00"', file=sys.stderr)
            sys.exit(2)
        payload["until"] = " ".join(sys.argv[2:])

    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"http://127.0.0.1:{SEND_PORT}/away", data=body,
        headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            res = json.load(r)
    except urllib.error.HTTPError as e:
        try:
            res = json.load(e)
        except Exception:  # noqa: BLE001
            print(f"Ошибка шлюза: HTTP {e.code}", file=sys.stderr)
            sys.exit(4)
    except (urllib.error.URLError, OSError):
        print("Telegram-слушатель не запущен.", file=sys.stderr)
        sys.exit(3)

    if res.get("ok"):
        if action == "on":
            print(f"OK: режим «отвечаю за тебя» включён до {res.get('until')} "
                  f"(продлю на час, если не вернёшься).")
        else:
            print("OK: режим «отвечаю за тебя» выключен — ты снова онлайн.")
    else:
        print(f"Не удалось: {res.get('error')}", file=sys.stderr)
        sys.exit(4)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        print(f"Ошибка: {e}", file=sys.stderr)
        sys.exit(1)
