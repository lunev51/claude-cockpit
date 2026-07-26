"""Запустить ПРОАКТИВНЫЕ переговоры о встрече: Юки сама пишет человеку в Telegram,
ведёт переписку (с памятью прошлых разговоров), согласует время, ставит встречу и
присылает итог в Избранное. Работает в фоне — ждать не нужно.

  python tg_negotiate.py "кому" "что согласовать (дата/промежуток времени)"
Пример:
  python tg_negotiate.py "Danil Nite" "встреча сегодня, удобное время в промежутке 15:00-18:00"
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
    if len(sys.argv) < 3:
        print('Использование: tg_negotiate.py "кому" "что согласовать"', file=sys.stderr)
        sys.exit(2)
    to = sys.argv[1]
    goal = " ".join(sys.argv[2:])
    body = json.dumps({"to": to, "goal": goal}).encode("utf-8")
    req = urllib.request.Request(
        f"http://127.0.0.1:{SEND_PORT}/negotiate", data=body,
        headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=150) as r:
            res = json.load(r)
    except urllib.error.HTTPError as e:
        try:
            res = json.load(e)
        except Exception:  # noqa: BLE001
            print(f"Ошибка шлюза: HTTP {e.code}", file=sys.stderr)
            sys.exit(4)
    except (urllib.error.URLError, OSError):
        print("Telegram-слушатель не запущен — переговоры недоступны.", file=sys.stderr)
        sys.exit(3)

    if res.get("ok"):
        print(f"OK: начала переговоры с «{res.get('name')}» — веду переписку, "
              f"итог пришлю в Избранное.")
    else:
        print(f"Не удалось: {res.get('error')}", file=sys.stderr)
        sys.exit(4)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        print(f"Ошибка: {e}", file=sys.stderr)
        sys.exit(1)
