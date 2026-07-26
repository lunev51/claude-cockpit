"""Полный список контактов и личных чатов Telegram (через шлюз слушателя).
Нужен, чтобы Юки сопоставила имя, которое назвал пользователь («Даниилу Найту»),
с тем, как человек записан в Telegram («Danil Nite»), и отправила точно по
@username или id.

Запуск: python tg_contacts.py
"""
import json
import os
import sys
import urllib.error
import urllib.request

# Windows: выводим UTF-8, иначе Claude Code прочитает как кракозябры.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass

SEND_PORT = int(os.environ.get("CC_TG_SEND_PORT", "48754"))


def main():
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{SEND_PORT}/contacts", timeout=40) as r:
            res = json.load(r)
    except (urllib.error.URLError, OSError):
        print("Telegram-слушатель не запущен — список контактов недоступен.", file=sys.stderr)
        sys.exit(3)

    items = res.get("items") or []
    if not items:
        print("Контактов не найдено.")
        return

    print(f"Контактов/чатов: {len(items)} (формат: Имя | @username | id)")
    for i in items:
        name = i.get("name") or "(без имени)"
        uname = f" | @{i['username']}" if i.get("username") else ""
        print(f"- {name}{uname} | id:{i.get('id')}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        print(f"Ошибка: {e}", file=sys.stderr)
        sys.exit(1)
