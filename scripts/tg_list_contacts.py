"""Список контактов и чатов в Telegram."""
import json
import os
from pyrogram import Client

HERE = os.path.dirname(os.path.abspath(__file__))
WORKDIR = os.path.abspath(os.path.join(HERE, "..", "..", "companion-home"))
SESSION = "tg_user"


def creds():
    with open(os.path.join(WORKDIR, ".tg.json"), encoding="utf-8") as f:
        j = json.load(f)
    return int(j["apiId"]), j["apiHash"]


def display_name(chat):
    return (
        getattr(chat, "title", None)
        or " ".join(filter(None, [getattr(chat, "first_name", None),
                                   getattr(chat, "last_name", None)]))
        or str(getattr(chat, "id", "")))


def main():
    if not os.path.exists(os.path.join(WORKDIR, SESSION + ".session")):
        print("Telegram не залогинен — запусти tg_login.py один раз.")
        return

    api_id, api_hash = creds()
    app = Client(SESSION, api_id=api_id, api_hash=api_hash, workdir=WORKDIR)

    with app:
        print("=== КОНТАКТЫ ===")
        try:
            contacts = list(app.get_contacts())
            if contacts:
                for c in contacts[:20]:  # Первые 20
                    name = " ".join(filter(None, [c.first_name, c.last_name]))
                    print(f"  • {name}")
            else:
                print("  (нет контактов)")
        except Exception as e:
            print(f"  Ошибка: {e}")

        print("\n=== НЕДАВНИЕ ЧАТЫ ===")
        try:
            dialogs = list(app.get_dialogs(limit=15))
            if dialogs:
                for d in dialogs:
                    name = display_name(d.chat)
                    print(f"  • {name}")
            else:
                print("  (нет чатов)")
        except Exception as e:
            print(f"  Ошибка: {e}")


if __name__ == "__main__":
    main()
