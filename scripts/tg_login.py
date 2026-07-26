"""Одноразовый вход в Telegram через Pyrogram (создаёт файл сессии).
Запускать ИНТЕРАКТИВНО (обычный терминал) — Pyrogram спросит номер телефона
и код подтверждения из Telegram. После входа сессия сохраняется в
companion-home/tg_user.session, и tg_send.py работает без повторных входов.

Запуск:
  C:\\Users\\Lunev\\akto\\.venv\\Scripts\\python.exe tg_login.py
"""
import json
import os
import sys

from pyrogram import Client

HERE = os.path.dirname(os.path.abspath(__file__))
# companion-home лежит рядом с claude-companion: ../../companion-home
WORKDIR = os.path.abspath(os.path.join(HERE, "..", "..", "companion-home"))
SESSION = "tg_user"


def creds():
    path = os.path.join(WORKDIR, ".tg.json")
    with open(path, encoding="utf-8") as f:
        j = json.load(f)
    return int(j["apiId"]), j["apiHash"]


def main():
    api_id, api_hash = creds()
    app = Client(SESSION, api_id=api_id, api_hash=api_hash, workdir=WORKDIR)
    with app:  # при отсутствии сессии — интерактивный вход (телефон + код)
        me = app.get_me()
        uname = f"@{me.username}" if me.username else "(без username)"
        print(f"OK: вошёл как {me.first_name} {uname} id={me.id}")
        print(f"Сессия сохранена: {os.path.join(WORKDIR, SESSION + '.session')}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        print(f"Ошибка входа: {e}", file=sys.stderr)
        sys.exit(1)
