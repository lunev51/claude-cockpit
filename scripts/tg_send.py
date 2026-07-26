"""Отправка текстового сообщения в Telegram от имени пользователя (Pyrogram).
Сессия создаётся один раз через tg_login.py.

Запуск:
  python tg_send.py "кому" "текст сообщения"

«кому» может быть:
  - @username           (например @durov)
  - имя контакта         (например «Даниил» — ищется среди контактов и чатов)
  - me / saved / себе    (Избранное — сообщения себе)
  - числовой chat id
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

from pyrogram import Client

HERE = os.path.dirname(os.path.abspath(__file__))
# Та же логика, что в tg_listen.py: env CC_TG_WORKDIR приоритетнее (упакованный exe).
WORKDIR = os.environ.get("CC_TG_WORKDIR") or os.path.abspath(
    os.path.join(HERE, "..", "..", "companion-home"))
SESSION = "tg_user"
# Шлюз отправки слушателя (если он запущен — сессию держит он, свою открыть нельзя).
SEND_PORT = int(os.environ.get("CC_TG_SEND_PORT", "48754"))

SELF_ALIASES = {"me", "saved", "я", "себе", "избранное"}


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


def resolve(app, target):
    """Возвращает идентификатор чата для send_message или None."""
    t = target.strip()
    low = t.lower()
    if low in SELF_ALIASES:
        return "me"
    if t.startswith("@") or t.lstrip("-").isdigit():
        return t
    # Поиск среди контактов по имени/фамилии.
    try:
        for c in app.get_contacts():
            name = " ".join(filter(None, [c.first_name, c.last_name])).lower()
            if name and low in name:
                return c.id
    except Exception:  # noqa: BLE001
        pass
    # Поиск среди диалогов по названию чата.
    try:
        for d in app.get_dialogs():
            if low in display_name(d.chat).lower():
                return d.chat.id
    except Exception:  # noqa: BLE001
        pass
    return None


def main():
    if len(sys.argv) < 3:
        print('Использование: tg_send.py "кому" "текст"', file=sys.stderr)
        sys.exit(2)
    target = sys.argv[1]
    text = " ".join(sys.argv[2:])

    # 1) Сначала пробуем шлюз слушателя (он держит сессию, когда companion открыт).
    try:
        body = json.dumps({"to": target, "text": text}).encode("utf-8")
        req = urllib.request.Request(
            f"http://127.0.0.1:{SEND_PORT}/send", data=body,
            headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as r:
            res = json.load(r)
        if res.get("ok"):
            print(f"OK: отправлено «{res.get('name')}»")
            return
        print(f"Не отправлено: {res.get('error')}", file=sys.stderr)
        sys.exit(4)
    except urllib.error.HTTPError as e:
        try:
            res = json.load(e)
            print(f"Не отправлено: {res.get('error')}", file=sys.stderr)
        except Exception:  # noqa: BLE001
            print(f"Ошибка шлюза: HTTP {e.code}", file=sys.stderr)
        sys.exit(4)
    except (urllib.error.URLError, OSError):
        pass  # шлюз недоступен (слушатель выключен) — шлём своей сессией ниже

    # 2) Фоллбэк: слушатель не запущен — открываем свою сессию.
    if not os.path.exists(os.path.join(WORKDIR, SESSION + ".session")):
        print("Telegram не залогинен — запусти tg_login.py один раз.", file=sys.stderr)
        sys.exit(3)

    api_id, api_hash = creds()
    app = Client(SESSION, api_id=api_id, api_hash=api_hash, workdir=WORKDIR)
    with app:
        chat = resolve(app, target)
        if chat is None:
            print(f"Не нашёл получателя «{target}». Укажи @username или точное имя контакта.",
                  file=sys.stderr)
            sys.exit(4)
        app.send_message(chat, text)
        name = display_name(app.get_chat(chat))
        print(f"OK: отправлено «{name}»")


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        print(f"Ошибка отправки: {e}", file=sys.stderr)
        sys.exit(1)
