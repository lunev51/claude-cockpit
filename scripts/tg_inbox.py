"""Показать непрочитанные личные сообщения Telegram (кто и что писал).
Работает через шлюз слушателя (tg_listen.py держит живую сессию).
Если слушатель не запущен — скажет об этом.

Запуск: python tg_inbox.py
"""
import json
import os
import sys
import urllib.error
import urllib.request

# Windows: stdout в пайп по умолчанию cp1251 → Claude Code читает как UTF-8 и
# получает кракозябры. Принудительно выводим UTF-8.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass

SEND_PORT = int(os.environ.get("CC_TG_SEND_PORT", "48754"))


def main():
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{SEND_PORT}/inbox", timeout=40) as r:
            res = json.load(r)
    except (urllib.error.URLError, OSError):
        print("Telegram-слушатель не запущен — входящие недоступны.", file=sys.stderr)
        sys.exit(3)

    items = res.get("items") or []
    if not items:
        print("Новых сообщений нет.")
        return

    total = sum(int(i.get("count", 0) or 0) for i in items)
    n = len(items)
    word = "собеседника" if n == 1 else "собеседников"
    print(f"Новых сообщений: {total} (от {n} {word}).")
    print("(«он:» — сообщение собеседника, «ты:» — что Юки ответила ему сама)")
    for i in items:
        name = i.get("name", "?")
        cnt = int(i.get("count", 0) or 0)
        print(f"- {name} (его сообщений: {cnt}):")
        for line in i.get("thread", []):
            print(f"    {line}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        print(f"Ошибка: {e}", file=sys.stderr)
        sys.exit(1)
