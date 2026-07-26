"""Персистентный слушатель Telegram (Pyrogram) для удалённого управления
companion-компаньоном.

Запускается из main-процесса Electron (tg-remote.js) как долгоживущий сайдкар.
Сессия и креды берутся из companion-home (созданы заранее tg_login.py).

Поведение:
  - Сообщения в Избранном (чат с самим собой) → команда хозяина: POST на
    http://127.0.0.1:<CC_SPEAK_PORT>/command {"text": ...} (уйдёт в терминал).
  - Личка от постороннего человека → авто-ответ через изолированную песочницу
    claude (tg-reply), с сохранением session_id на каждого собеседника.
  - Всё остальное (группы, каналы, боты, свои исходящие чужим) — игнор.

Env-флаги (передаёт main):
  CC_SPEAK_PORT   — порт speak-сервера companion для инъекции команд.
  CC_TG_COMMANDS  — '1'/'0', обрабатывать ли команды из Избранного (по умолч. 1).
  CC_TG_AUTOREPLY — '1'/'0', авто-отвечать ли посторонним (по умолч. 1).
"""
import datetime
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from pyrogram import Client
from pyrogram.enums import ChatType

HERE = os.path.dirname(os.path.abspath(__file__))
# Рабочая папка (там .tg.json, tg_user.session, .tg-sessions.json) — из env
# CC_TG_WORKDIR (передаёт main). В упакованном exe относительный путь указал бы
# мимо, поэтому env приоритетнее; фоллбэк — companion-home рядом со скриптом.
WORKDIR = os.environ.get("CC_TG_WORKDIR") or os.path.abspath(
    os.path.join(HERE, "..", "..", "companion-home"))
SESSION = "tg_user"

# Песочница для ответов посторонним (свой CLAUDE.md + deny всех инструментов),
# рядом с рабочей папкой: <workdir>/../tg-reply.
SANDBOX = os.environ.get("CC_TG_SANDBOX") or os.path.abspath(
    os.path.join(WORKDIR, "..", "tg-reply"))
SESSIONS_FILE = os.path.join(WORKDIR, ".tg-sessions.json")

# claude.exe: на PATH как 'claude', но укажем полный путь как основной вариант.
CLAUDE = r"C:\Users\Lunev\.local\bin\claude.exe"
if not os.path.exists(CLAUDE):
    CLAUDE = "claude"

DISALLOWED = "Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,Task,NotebookEdit,TodoWrite"

SPEAK_PORT = os.environ.get("CC_SPEAK_PORT", "")
TG_COMMANDS = os.environ.get("CC_TG_COMMANDS", "1") == "1"
TG_AUTOREPLY = os.environ.get("CC_TG_AUTOREPLY", "1") == "1"
# Локальный порт «шлюза отправки»: tg_send.py шлёт сюда, чтобы не конфликтовать
# за файл сессии (его держит этот процесс). 127.0.0.1 only.
SEND_PORT = int(os.environ.get("CC_TG_SEND_PORT", "48754"))

# Заполняются в main() после старта клиента — нужны send-серверу.
APP = None
MY_ID = None
SELF_ALIASES = {"me", "saved", "я", "себе", "избранное"}


def log(*a):
    print("[tg-listen]", *a, file=sys.stderr, flush=True)


def creds():
    # utf-8-sig: терпим UTF-8 BOM (PowerShell иногда дописывает его при правках).
    with open(os.path.join(WORKDIR, ".tg.json"), encoding="utf-8-sig") as f:
        j = json.load(f)
    return int(j["apiId"]), j["apiHash"]


# --- Маппинг chat_id → session_id (персист в companion-home) ---
def load_sessions():
    try:
        with open(SESSIONS_FILE, encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except Exception:  # noqa: BLE001
        return {}


def save_sessions(d):
    try:
        with open(SESSIONS_FILE, "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False, indent=2)
    except Exception as e:  # noqa: BLE001
        log("не сохранить сессии:", e)


SESSIONS = load_sessions()
# chat_id, для которых сейчас генерируется ответ (анти-конкурентность).
BUSY = set()


# --- Активные ПРОАКТИВНЫЕ переговоры о встрече (юзер поручил Юки договориться) ---
# {str(chat_id): {goal, name, ts}}. Пока чат здесь — его сообщения идут в
# переговорный суб-агент (не в обычный авто-ответ) и НЕ пишутся в журнал входящих.
NEGOTIATIONS_FILE = os.path.join(WORKDIR, ".tg-negotiations.json")


def load_negotiations():
    try:
        with open(NEGOTIATIONS_FILE, encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except Exception:  # noqa: BLE001
        return {}


def save_negotiations():
    try:
        with open(NEGOTIATIONS_FILE, "w", encoding="utf-8") as f:
            json.dump(NEGOTIATIONS, f, ensure_ascii=False, indent=2)
    except Exception as e:  # noqa: BLE001
        log("не сохранить переговоры:", e)


NEGOTIATIONS = load_negotiations()


# --- Журнал входящих от посторонних (для «кто мне писал?») ---
# Нужен, потому что после авто-ответа Telegram помечает чат прочитанным
# (unread=0), и такой собеседник пропадал бы из сводки по непрочитанным.
INBOX_FILE = os.path.join(WORKDIR, ".tg-inbox.json")
INBOX_LOCK = threading.Lock()
INBOX_MAX = 80


def _load_inbox():
    try:
        with open(INBOX_FILE, encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, list) else []
    except Exception:  # noqa: BLE001
        return []


def _save_inbox(events):
    try:
        with open(INBOX_FILE, "w", encoding="utf-8") as f:
            json.dump(events[-INBOX_MAX:], f, ensure_ascii=False, indent=2)
    except Exception as e:  # noqa: BLE001
        log("не сохранить журнал входящих:", e)


def _log_msg(chat_id, name, text, direction):
    with INBOX_LOCK:
        events = _load_inbox()
        events.append({
            "chat_id": chat_id,
            "name": name,
            "text": (text or "")[:600],
            "ts": int(time.time()),
            "dir": direction,  # 'in' — собеседник, 'out' — ответ Юки
        })
        _save_inbox(events)


def log_incoming(chat_id, name, text):
    """Записать ВХОДЯЩЕЕ сообщение собеседника в журнал переписки."""
    _log_msg(chat_id, name, text, "in")


def log_outgoing(chat_id, name, text):
    """Записать ОТВЕТ Юки в журнал — чтобы по запросу было видно, о чём
    договорились (например, что согласован созвон), а не только что «ответила»."""
    _log_msg(chat_id, name, text, "out")


# --- Отметки «о чём владельцу уже сообщали» (чтобы не выдавать старое за новое) ---
NOTIFIED_FILE = os.path.join(WORKDIR, ".tg-notified.json")


def _load_notified():
    try:
        with open(NOTIFIED_FILE, encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except Exception:  # noqa: BLE001
        return {}


def _save_notified(d):
    try:
        with open(NOTIFIED_FILE, "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False, indent=2)
    except Exception as e:  # noqa: BLE001
        log("не сохранить отметки уведомлений:", e)


def inject_command(text, echo=True):
    """POST команды/уведомления в speak-сервер companion → терминал основной Юки.
    echo=False — для авто-уведомлений (ответ Юки НЕ дублировать обратно в Telegram)."""
    if not SPEAK_PORT:
        log("нет CC_SPEAK_PORT — команда не отправлена")
        return
    try:
        body = json.dumps({"text": text, "echo": echo}).encode("utf-8")
        req = urllib.request.Request(
            f"http://127.0.0.1:{SPEAK_PORT}/command",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=10).read()
        log("команда отправлена в терминал")
    except Exception as e:  # noqa: BLE001
        log("инъекция команды не удалась:", e)


def _run_claude(text, sid):
    """Запуск claude в песочнице. Возвращает (result, session_id) или (None, None)."""
    cmd = [CLAUDE]
    if sid:
        cmd += ["--resume", sid]
    cmd += ["-p", text, "--output-format", "json", "--disallowedTools", DISALLOWED]
    try:
        p = subprocess.run(
            cmd,
            cwd=SANDBOX,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=120,
        )
    except Exception as e:  # noqa: BLE001
        log("claude не запустился:", e)
        return None, None
    if p.returncode != 0 or not p.stdout.strip():
        log("claude rc=", p.returncode, "stderr:", (p.stderr or "").strip()[:200])
        return None, None
    try:
        j = json.loads(p.stdout)
    except Exception as e:  # noqa: BLE001
        log("claude: не распарсить JSON:", e)
        return None, None
    return j.get("result"), j.get("session_id")


def generate_reply(chat_id):
    """Сгенерировать ответ постороннему. Возвращает текст или None."""
    text = generate_reply.text  # передаётся через атрибут (см. вызов)
    sid = SESSIONS.get(str(chat_id))
    result, new_sid = _run_claude(text, sid)
    # Если был resume и он провалился — повторяем со свежей сессией.
    if result is None and sid:
        log("resume провалился — пробуем свежую сессию")
        result, new_sid = _run_claude(text, None)
    if result is None:
        return "Привет! Я ассистент, передам сообщение, когда смогу."
    if new_sid:
        SESSIONS[str(chat_id)] = new_sid
        save_sessions(SESSIONS)
    return result.strip()[:3500]


# ── Календарь: автосогласование встреч для КОНТАКТОВ ────────────────
# Песочница остаётся БЕЗ инструментов: ей лишь дают свободные окна и просят
# при согласовании добавить директиву @@BOOK …@@. Само событие создаёт этот
# (доверенный) код через проверенные скрипты gcal-*. Никакой посторонний так
# не получит доступ к календарю — только контакты, только в рамках правил.
GCAL_DIR = os.path.abspath(os.path.join(WORKDIR, "..", "claude-companion", "scripts"))
GCAL_DURATION = 30  # длительность по умолчанию для предложенных слотов/брони
BOOK_RE = re.compile(
    r"@@BOOK\s+(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})\s*\|\s*([A-Za-z0-9_/+\-]+)\s*\|\s*(.+?)\s*@@",
    re.S)


def _run_node(args, timeout=60):
    try:
        p = subprocess.run(
            ["node"] + args, cwd=GCAL_DIR, stdin=subprocess.DEVNULL,
            capture_output=True, text=True, encoding="utf-8", timeout=timeout,
            env={**os.environ, "CC_HOME": WORKDIR})
        return p.returncode, (p.stdout or ""), (p.stderr or "")
    except Exception as e:  # noqa: BLE001
        return 1, "", str(e)


def _gcal_configured():
    return (os.path.exists(os.path.join(WORKDIR, ".gcal.json"))
            and os.path.exists(os.path.join(WORKDIR, ".gcal-token.json")))


def _goal_type(goal):
    """Тип события по цели/поручению: 'meeting' если про встречу, иначе 'call'."""
    return "meeting" if "встреч" in (goal or "").lower() else "call"


def _gcal_slots(slot_type="call"):
    rc, out, _ = _run_node([os.path.join(GCAL_DIR, "gcal-slots.js"),
                            "--json", "--days", "7", "--duration", str(GCAL_DURATION),
                            "--type", slot_type])
    if rc != 0 or not out.strip():
        return None
    try:
        return json.loads(out)
    except Exception:  # noqa: BLE001
        return None


def _autoonly_ok(fu, sender, auto_only):
    if not auto_only:
        return True
    uname = ("@" + fu.username).lower() if getattr(fu, "username", None) else ""
    name = (sender or "").lower()
    for entry in auto_only:
        e = str(entry).lower().strip()
        if not e:
            continue
        if uname and e == uname:
            return True
        if name and (e in name or name in e):
            return True
    return False


def _calendar_context(fu, sender):
    """(можно_планировать, slots_json). Только контакты, при вкл, в рамках правил."""
    if not _gcal_configured():
        return False, None
    if not getattr(fu, "is_contact", False):
        return False, None
    data = _gcal_slots()
    if not data or not data.get("autoEnabled"):
        return False, None
    if not _autoonly_ok(fu, sender, data.get("autoOnly") or []):
        return False, None
    return True, data


_RU_WD = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]


def _format_ranges(ranges):
    by_day, order = {}, []
    for r in (ranges or []):
        d = r.get("date")
        if d not in by_day:
            by_day[d] = []
            order.append(d)
        by_day[d].append(f"{r.get('start')}–{r.get('end')}")
    if not order:
        return "(свободных интервалов сейчас нет)"
    lines = []
    for d in order:
        try:
            y, m, dd = map(int, d.split("-"))
            wd = _RU_WD[datetime.date(y, m, dd).weekday()]
        except Exception:  # noqa: BLE001
            wd = ""
        lines.append(f"- {d} ({wd}): " + ", ".join(by_day[d]))
    return "\n".join(lines)


def _calendar_prompt(sender, text, data, introduce=False):
    tz = data.get("timezone", "Europe/Warsaw")
    today = data.get("today", "")
    dur = data.get("durationMin", 30)
    return (
        f"Тебе пишет твой КОНТАКТ по имени {sender} (это НЕ Данил — он сейчас недоступен). "
        f"Его сообщение: «{text}»\n\n"
        f"Сегодня {today}. Ты — ассистент Данила и можешь САМА согласовать встречу/созвон и "
        f"поставить её в календарь Данила. Свободные ИНТЕРВАЛЫ Данила на ближайшие дни (пояс {tz}):\n"
        f"{_format_ranges(data.get('ranges'))}\n\n"
        f"Правила:\n"
        f"1) Внутри этих интервалов предлагай и соглашайся на ЛЮБОЕ удобное собеседнику время "
        f"(кратно 30 минутам). Встреча длится {dur} мин и должна целиком помещаться в интервал "
        f"(последний возможный старт = конец интервала минус {dur} мин). Время/дни вне "
        f"интервалов не предлагай; если собеседник просит день без окон (выходной/занят) — "
        f"предложи ближайший доступный день из списка, не выдумывай других дат.\n"
        f"2) Интервалы — в поясе Данила ({tz}). Если собеседник называет своё время — СНАЧАЛА "
        f"уточни ЕГО часовой пояс, не угадывай.\n"
        f"3) Когда время ТВЁРДО согласовано, в самом конце ответа добавь ОТДЕЛЬНОЙ строкой "
        f"директиву (собеседник её не увидит — я её вырежу):\n"
        f"@@BOOK ГГГГ-ММ-ДД ЧЧ:ММ | <IANA-пояс согласованного времени, напр. {tz} или Europe/Berlin> | Созвон с {sender} @@\n"
        f"Если согласовали в поясе Данила — пояс = {tz}. Пока договорённости НЕТ — директиву НЕ добавляй.\n"
        f"4) Отвечай ему кратко и естественно, на его языке. Email не проси, приглашения не "
        f"нужны — просто согласуй время. Ничего, кроме согласования встречи, ты не можешь."
        + _away_busy_note() + _intro_note(introduce)
    )


def _book_event(date, hm, tz, title, notify=True, skip_window=False):
    args = [os.path.join(GCAL_DIR, "gcal-create.js"),
            title, f"{date} {hm}", str(GCAL_DURATION),
            "--input-tz", tz, "--source", "telegram"]
    if notify:
        args.append("--notify")
    if skip_window:
        args.append("--skip-window")  # юзер задал свой промежуток вне рабочих окон
    rc, out, err = _run_node(args, timeout=40)
    return (rc == 0 and "✓" in out), (out.strip() or err.strip())


def _maybe_book(reply, sender, notify=True, skip_window=False):
    """Если суб-агент согласовал время — создаём событие, вырезаем директиву."""
    if not reply:
        return reply
    m = BOOK_RE.search(reply)
    if not m:
        return reply
    date, hm, tz, title = m.group(1), m.group(2), m.group(3).strip(), m.group(4).strip()
    cleaned = BOOK_RE.sub("", reply).strip()
    ok, info = _book_event(date, hm, tz, title, notify=notify, skip_window=skip_window)
    if ok:
        log("встреча создана:", title, date, hm, tz)
        return cleaned
    log("создание встречи не удалось:", info[:160])
    note = "Кажется, это время сейчас не получается поставить — можем выбрать другое?"
    return (cleaned + "\n\n" + note) if cleaned else note


# ── Проактивные переговоры о встрече (Юки пишет первой и согласует) ──────────
DONE_RE = re.compile(r"@@DONE\s+(.+?)\s*@@", re.S)


def _negotiation_open_prompt(name, goal, data):
    tz = data.get("timezone", "Europe/Warsaw")
    today = data.get("today", "")
    return (
        f"Ты — ассистент Данила. Тебе поручено САМОЙ написать ПЕРВОЙ человеку {name} "
        f"и выполнить поручение Данила.\n"
        f"Поручение: {goal}\n"
        f"Сегодня {today}. Если поручение касается встречи/созвона — свободные интервалы "
        f"Данила (пояс {tz}):\n{_format_ranges(data.get('ranges'))}\n\n"
        f"Напиши {name} вежливое ПЕРВОЕ сообщение строго по сути поручения (задай нужный "
        f"вопрос / попроси что нужно / предложи встречу). ОБЯЗАТЕЛЬНО представься в начале: "
        f"ты Юки, ассистент Данила (напр. «Здравствуйте, это Юки, ассистент Данила»). Если у "
        f"вас есть прошлая переписка — учитывай её тон. Выведи ТОЛЬКО текст сообщения для "
        f"отправки — без пояснений и без служебных директив."
    )


def _negotiation_reply_prompt(name, goal, text, data):
    tz = data.get("timezone", "Europe/Warsaw")
    today = data.get("today", "")
    tw = "Созвон" if _goal_type(goal) == "call" else "Встреча"  # в названии события
    return (
        f"Ты выполняешь поручение Данила в переписке с {name}. Поручение: {goal}\n"
        f"Сегодня {today}. Если поручение про встречу/созвон — свободные интервалы Данила "
        f"(пояс {tz}):\n{_format_ranges(data.get('ranges'))}\n\n"
        f"{name} только что ответил: «{text}»\n\n"
        f"Продолжай переписку, пока не выполнишь поручение. Отвечай {name} кратко и по делу.\n"
        f"— Если поручение про ВСТРЕЧУ/СОЗВОН и время ТВЁРДО согласовано: добавь в конце "
        f"ОТДЕЛЬНОЙ строкой @@BOOK ГГГГ-ММ-ДД ЧЧ:ММ | <IANA-пояс, напр. {tz}> | {tw} с {name} @@.\n"
        f"— Когда поручение ВЫПОЛНЕНО (получил нужную информацию/ответ, договорился, либо "
        f"человек дал окончательный ответ): добавь ОТДЕЛЬНОЙ строкой "
        f"@@DONE <итог: что узнал / о чём договорились, человеческим языком, упомяни {name}> @@.\n"
        f"— Пока поручение НЕ выполнено — продолжай переписку без @@DONE.\n"
        f"Пояса (если про встречу): интервалы в поясе Данила ({tz}); если человек называет своё "
        f"время — сперва уточни его часовой пояс. Директивы собеседник не увидит — я их вырежу."
    )


def start_negotiation(to, goal):
    """Запустить проактивные переговоры. Возвращает (имя, None) | (None, ошибка)."""
    if not _gcal_configured():
        return None, "Календарь не настроен"
    target = resolve(to)
    if target is None:
        return None, f"Не нашёл получателя «{to}»"
    try:
        chat = APP.get_chat(target)
        cid, name = chat.id, _display_name(chat)
    except Exception as e:  # noqa: BLE001
        return None, f"не удалось открыть чат: {e}"
    if cid == MY_ID:
        return None, "нельзя вести переговоры с самим собой"
    data = _gcal_slots(_goal_type(goal)) or {}
    generate_reply.text = _negotiation_open_prompt(name, goal, data)
    opening = generate_reply(cid)
    if not opening:
        return None, "не удалось сгенерировать сообщение"
    try:
        APP.send_message(cid, opening)
    except Exception as e:  # noqa: BLE001
        return None, f"не удалось отправить: {e}"
    NEGOTIATIONS[str(cid)] = {"goal": goal, "name": name, "ts": int(time.time())}
    save_negotiations()
    log("переговоры начаты с", cid, name)
    return name, None


def _handle_negotiation_reply(client, cid, sender, text):
    """Ответ собеседника в рамках активных переговоров: продолжить/забронировать/закрыть."""
    neg = NEGOTIATIONS.get(str(cid))
    if not neg or cid in BUSY:
        return
    BUSY.add(cid)
    try:
        name = neg.get("name") or sender
        data = _gcal_slots(_goal_type(neg.get("goal", ""))) or {}
        generate_reply.text = _negotiation_reply_prompt(name, neg.get("goal", ""), text, data)
        reply = generate_reply(cid)
        if not reply:
            return
        # @@BOOK → бронируем (без --notify; уважаем заданный промежуток); @@DONE → закрыть.
        reply = _maybe_book(reply, name, notify=False, skip_window=True)
        done = DONE_RE.search(reply)
        if done:
            outcome = done.group(1).strip()
            reply = DONE_RE.sub("", reply).strip()
            NEGOTIATIONS.pop(str(cid), None)
            save_negotiations()
            try:
                APP.send_message("me", f"📨 {outcome}")
            except Exception as e:  # noqa: BLE001
                log("итог поручения в Избранное не ушёл:", e)
            # И в терминал — Юки озвучит итог владельцу (echo=False: не дублировать
            # обратно в Telegram, иначе уйдёт двойное уведомление).
            inject_command(
                f"[Telegram-уведомление] Поручение выполнено. {outcome} "
                f"Сообщи об этом владельцу коротко и по-человечески.",
                echo=False)
            log("поручение выполнено с", cid, "—", outcome[:80])
        if reply:
            client.send_message(cid, reply)
            log("переговоры: ответ отправлен", cid)
    finally:
        BUSY.discard(cid)


# ── Режим «отвечаю за тебя» (away): включается, когда юзер ушёл офлайн ───────
# По умолчанию ВЫКЛ (при старте за юзера никто не отвечает — он сам). Юзер
# говорит Юки «я ушёл до 18:00» → set_away; «я онлайн» → clear_away. Пока active —
# работает реактивный авто-ответ. until — до скольки занят (говорим ТОЛЬКО если
# спросят) и дедлайн авто-продления: не вернулся к сроку → +1 час.
AWAY = {"active": False, "until": 0}
AWAY_TIMER = None
AWAY_EXTEND_SEC = 3600


def is_away():
    return bool(AWAY["active"])


def _fmt_until(epoch):
    try:
        return datetime.datetime.fromtimestamp(int(epoch)).strftime("%H:%M")
    except Exception:  # noqa: BLE001
        return "?"


def _parse_until(s):
    """«ЧЧ:ММ» (сегодня, иначе завтра) или «ГГГГ-ММ-ДД ЧЧ:ММ» → epoch (локальное)."""
    s = (s or "").strip()
    now = datetime.datetime.now()
    m = re.match(r"^(\d{1,2}):(\d{2})$", s)
    if m:
        t = now.replace(hour=int(m.group(1)) % 24, minute=int(m.group(2)) % 60,
                        second=0, microsecond=0)
        if t <= now:
            t += datetime.timedelta(days=1)
        return int(t.timestamp())
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})", s)
    if m:
        try:
            return int(datetime.datetime(
                int(m.group(1)), int(m.group(2)), int(m.group(3)),
                int(m.group(4)), int(m.group(5))).timestamp())
        except Exception:  # noqa: BLE001
            return None
    return None


def _cancel_away_timer():
    global AWAY_TIMER
    if AWAY_TIMER is not None:
        try:
            AWAY_TIMER.cancel()
        except Exception:  # noqa: BLE001
            pass
        AWAY_TIMER = None


def _schedule_away_timer():
    global AWAY_TIMER
    _cancel_away_timer()
    if not AWAY["active"]:
        return
    delay = max(1, int(AWAY["until"]) - int(time.time()))
    AWAY_TIMER = threading.Timer(delay, _on_away_deadline)
    AWAY_TIMER.daemon = True
    AWAY_TIMER.start()


def _on_away_deadline():
    if not AWAY["active"]:
        return
    AWAY["until"] = int(time.time()) + AWAY_EXTEND_SEC  # не вернулся → +1 час
    log("away: юзер не вернулся → продлено до", _fmt_until(AWAY["until"]))
    inject_command(
        f"[Telegram-уведомление] Ты ещё не вернулся, поэтому я продлила режим "
        f"«отвечаю за тебя» на час — до {_fmt_until(AWAY['until'])}.", echo=False)
    _schedule_away_timer()


def set_away(until_epoch):
    AWAY["active"] = True
    AWAY["until"] = int(until_epoch)
    _schedule_away_timer()
    log("away: включён до", _fmt_until(AWAY["until"]))


def clear_away():
    was = AWAY["active"]
    AWAY["active"] = False
    AWAY["until"] = 0
    _cancel_away_timer()
    if was:
        log("away: выключен (юзер онлайн)")


def _away_busy_note():
    """Добавка к промпту авто-ответа: до скольки занят (упоминать ТОЛЬКО если спросят)."""
    if not AWAY["active"] or not AWAY["until"]:
        return ""
    hhmm = _fmt_until(AWAY["until"])
    return (f"\n\nВАЖНО: Данил сейчас офлайн примерно до {hhmm}. Если собеседник спросит, когда "
            f"Данил будет на связи или почему не отвечает лично — можешь сказать, что он занят "
            f"примерно до {hhmm}. По своей инициативе про это НЕ упоминай.")


# ── Представление ассистентом (Юки) ────────────────────────────────────────
def _intro_note(introduce):
    if introduce:
        return ("\n\nЭто начало разговора (вы давно не переписывались) — В НАЧАЛЕ ответа "
                "коротко представься: ты Юки, ассистент Данила (напр. «Здравствуйте, это Юки, "
                "ассистент Данила»), и дальше по сути.")
    return "\n\nВы уже в активном диалоге — представляться повторно НЕ нужно, отвечай по сути."


def _is_fresh_conversation(cid, message):
    """True, если предыдущее сообщение в чате старше 30 мин (или его нет) — повод
    представиться. False — переписка активна (общались только что)."""
    try:
        prev, n = None, 0
        for m in APP.get_chat_history(cid, limit=2):
            n += 1
            if n == 1:
                continue  # текущее входящее
            prev = m
            break
        if prev is None or getattr(prev, "date", None) is None:
            return True
        now_ts = message.date.timestamp() if getattr(message, "date", None) else time.time()
        return (now_ts - prev.date.timestamp()) > 1800
    except Exception:  # noqa: BLE001
        return True  # при сомнении — лучше представиться


# --- Шлюз отправки: резолв получателя + send через живую сессию ---
def _display_name(chat):
    return (getattr(chat, "title", None)
            or " ".join(filter(None, [getattr(chat, "first_name", None),
                                      getattr(chat, "last_name", None)]))
            or str(getattr(chat, "id", "")))


def resolve(target):
    t = str(target).strip()
    low = t.lower()
    if low in SELF_ALIASES:
        return "me"
    if t.startswith("@") or t.lstrip("-").isdigit():
        return t
    try:
        for c in APP.get_contacts():
            name = " ".join(filter(None, [c.first_name, c.last_name])).lower()
            if name and low in name:
                return c.id
    except Exception:  # noqa: BLE001
        pass
    try:
        for d in APP.get_dialogs():
            if low in _display_name(d.chat).lower():
                return d.chat.id
    except Exception:  # noqa: BLE001
        pass
    return None


def send_via_app(to, text):
    chat = resolve(to)
    if chat is None:
        return None, f"Не нашёл получателя «{to}»"
    APP.send_message(chat, text)
    return _display_name(APP.get_chat(chat)), None


def fetch_inbox(limit=20):
    """«Кто мне писал» — сливаем журнал входящих: группируем по людям, отдаём
    выжимку и ОЧИЩАЕМ журнал. Спросил → показали и стёрли; пришли новые —
    появятся снова; не приходили — честно «новых нет». Журнал наполняет
    log_incoming на каждое входящее (и контакты, и посторонние)."""
    with INBOX_LOCK:
        events = _load_inbox()
        if events:
            _save_inbox([])  # слили — очищаем, второй раз та же переписка не повторится

    by_chat, order = {}, []
    for e in events:
        cid = e.get("chat_id")
        if cid not in by_chat:
            by_chat[cid] = {"name": e.get("name", "?"), "events": []}
            order.append(cid)
        g = by_chat[cid]
        if e.get("name") and e.get("dir") != "out":
            g["name"] = e["name"]  # имя берём из входящих
        g["events"].append(e)

    items = []
    for cid in order[:limit]:
        g = by_chat[cid]
        evs = sorted(g["events"], key=lambda e: e.get("ts", 0))
        incoming = sum(1 for e in evs if e.get("dir") != "out")
        thread = []
        for e in evs:
            t = (e.get("text") or "").replace("\n", " ").strip()
            if not t:
                continue
            who = "ты" if e.get("dir") == "out" else "он"
            thread.append(f"{who}: {t}")
        items.append({
            "name": g["name"],
            "count": incoming,
            "thread": thread[-14:],  # последние реплики переписки
        })
    return items


def fetch_contacts():
    """Полный список контактов + личных чатов: имя, @username, id. Чтобы Юки
    сопоставила имя, названное пользователем, с тем, как записано в Telegram."""
    out, seen = [], set()

    def add(cid, name, username):
        if cid is None or cid in seen:
            return
        name = (name or "").strip()
        username = (username or "").strip()
        if not name and not username:
            return
        seen.add(cid)
        out.append({"id": cid, "name": name, "username": username})

    try:
        for c in APP.get_contacts():
            full = " ".join(filter(None, [c.first_name, c.last_name]))
            add(c.id, full, getattr(c, "username", "") or "")
    except Exception as e:  # noqa: BLE001
        log("contacts: ошибка контактов:", e)
    try:
        for d in APP.get_dialogs(limit=150):
            ch = d.chat
            if ch is None or ch.type != ChatType.PRIVATE:
                continue
            add(ch.id, _display_name(ch), getattr(ch, "username", "") or "")
    except Exception as e:  # noqa: BLE001
        log("contacts: ошибка диалогов:", e)
    return out


class _SendHandler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # тихо
        pass

    def _json(self, out, code):
        data = json.dumps(out, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/ping":  # health-check (НЕ сливает журнал)
            self._json({"ok": True}, 200); return
        if self.path == "/contacts":
            try:
                self._json({"ok": True, "items": fetch_contacts()}, 200)
            except Exception as e:  # noqa: BLE001
                self._json({"ok": False, "error": str(e)}, 500)
            return
        if self.path != "/inbox":
            self.send_response(404); self.end_headers(); return
        try:
            self._json({"ok": True, "items": fetch_inbox()}, 200)
        except Exception as e:  # noqa: BLE001
            self._json({"ok": False, "error": str(e)}, 500)

    def do_POST(self):
        if self.path == "/away":  # режим «отвечаю за тебя» (вкл/выкл)
            try:
                n = int(self.headers.get("Content-Length", "0"))
                body = json.loads(self.rfile.read(n).decode("utf-8"))
                action = (body.get("action") or "").lower()
                if action == "on":
                    until = _parse_until(body.get("until", ""))
                    if until is None:
                        out, code = {"ok": False, "error": "не понял время"}, 400
                    else:
                        set_away(until)
                        out, code = {"ok": True, "until": _fmt_until(until)}, 200
                elif action == "off":
                    clear_away()
                    out, code = {"ok": True}, 200
                else:
                    out, code = {"ok": False, "error": "нужен action on|off"}, 400
            except Exception as e:  # noqa: BLE001
                out, code = {"ok": False, "error": str(e)}, 500
            self._json(out, code); return
        if self.path == "/negotiate":  # проактивные переговоры о встрече
            try:
                n = int(self.headers.get("Content-Length", "0"))
                body = json.loads(self.rfile.read(n).decode("utf-8"))
                to, goal = body.get("to"), body.get("goal")
                if not to or not goal:
                    raise ValueError("нужны поля to и goal")
                name, err = start_negotiation(to, goal)
                out = {"ok": err is None, "name": name, "error": err}
                code = 200 if err is None else 400
            except Exception as e:  # noqa: BLE001
                out, code = {"ok": False, "error": str(e)}, 500
            self._json(out, code); return
        if self.path != "/send":
            self.send_response(404); self.end_headers(); return
        try:
            n = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(n).decode("utf-8"))
            to, text = body.get("to"), body.get("text")
            if not to or not text:
                raise ValueError("нужны поля to и text")
            name, err = send_via_app(to, text)
            out = {"ok": err is None, "name": name, "error": err}
            code = 200 if err is None else 400
        except Exception as e:  # noqa: BLE001
            out, code = {"ok": False, "error": str(e)}, 500
        data = json.dumps(out, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def start_send_server():
    try:
        srv = ThreadingHTTPServer(("127.0.0.1", SEND_PORT), _SendHandler)
    except OSError as e:
        log(f"send-сервер не поднялся на {SEND_PORT}: {e}")
        return
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    log(f"шлюз отправки на 127.0.0.1:{SEND_PORT}")


def main():
    if not os.path.exists(os.path.join(WORKDIR, SESSION + ".session")):
        log("Telegram не залогинен — запусти tg_login.py один раз.")
        sys.exit(3)

    api_id, api_hash = creds()
    app = Client(SESSION, api_id=api_id, api_hash=api_hash, workdir=WORKDIR)

    with app:
        me = app.get_me()
    my_id = me.id
    log(f"вошёл как id={my_id}; commands={TG_COMMANDS} autoreply={TG_AUTOREPLY}")

    # Пересоздаём клиент для долгоживущего run() (with app выше — только для get_me).
    app = Client(SESSION, api_id=api_id, api_hash=api_hash, workdir=WORKDIR)

    # Глобали для send-сервера + поднимаем шлюз отправки (для tg_send.py).
    global APP, MY_ID
    APP = app
    MY_ID = my_id

    @app.on_message()
    def handler(client, message):
        try:
            chat = message.chat
            if chat is None:
                return

            # a) ИЗБРАННОЕ (чат с самим собой) — команда хозяина.
            # Сообщения себе исходящие (outgoing), по incoming не фильтруем.
            if chat.id == my_id:
                txt = message.text or ""
                # Свои авто-сообщения в Избранное (эхо-ответ 🤖, уведомление о
                # встрече 📅) — это НЕ команды, иначе они зациклятся.
                head = txt.lstrip()
                if head.startswith("🤖") or head.startswith("📅") or head.startswith("📨"):
                    return
                if TG_COMMANDS and txt:
                    inject_command(txt)
                return

            # b) ЛИЧКА ОТ ПОСТОРОННЕГО.
            if chat.type != ChatType.PRIVATE:
                return
            if message.outgoing:
                return
            fu = message.from_user
            if fu is None or getattr(fu, "is_bot", False) or fu.id == my_id:
                return
            text = message.text
            if not text:
                return
            sender = " ".join(filter(None, [fu.first_name, fu.last_name])) or "собеседник"

            # Активные ПРОАКТИВНЫЕ переговоры с этим человеком: ведёт переговорный
            # суб-агент. НЕ пишем в журнал входящих (чтобы не засорять) и НЕ
            # запускаем обычный авто-ответ.
            if str(chat.id) in NEGOTIATIONS:
                _handle_negotiation_reply(client, chat.id, sender, text)
                return

            # Журнал «кто мне писал» — фиксируем ВСЕГДА, даже если авто-ответ
            # выключен или сработает позже: иначе после авто-ответа чат станет
            # прочитанным (unread=0) и собеседник пропадёт из сводки.
            log_incoming(chat.id, sender, text)

            # Авто-ответ — ТОЛЬКО в режиме «отвечаю за тебя» (away). Иначе (юзер
            # онлайн) сообщение лишь попадает в журнал, а отвечает юзер сам.
            if not (TG_AUTOREPLY and is_away()):
                return

            # Представляться ли (реактив: только если давно не переписывались).
            introduce = _is_fresh_conversation(chat.id, message)

            # Обёртка: явно говорим, что пишет ПОСТОРОННИЙ (не хозяин), с именем —
            # иначе песочница отвечает так, будто это сам Данил с ней говорит.
            wrapped = (
                f"Тебе НАПИСАЛ ПОСТОРОННИЙ человек по имени {sender} "
                f"(это НЕ Данил — твой владелец сейчас недоступен). "
                f"Его сообщение тебе: «{text}»\n\n"
                f"Ответь напрямую ЕМУ ({sender}) как ассистент Данила — вежливо, кратко, "
                f"на его языке. Обращайся к нему, а не к Данилу. Если просит что-то "
                f"сделать — скажи, что передашь Данилу. Ничего на ПК выполнить ты не можешь."
                + _away_busy_note() + _intro_note(introduce)
            )

            cid = chat.id
            if cid in BUSY:
                log("занят для", cid, "— пропуск")
                return
            BUSY.add(cid)
            try:
                # Контакту — даём календарный контекст (может согласовать встречу);
                # постороннему — обычный ответ без доступа к календарю.
                allow_cal, cal_data = _calendar_context(fu, sender)
                if allow_cal:
                    generate_reply.text = _calendar_prompt(sender, text, cal_data, introduce)
                    reply = _maybe_book(generate_reply(cid), sender)
                else:
                    generate_reply.text = wrapped
                    reply = generate_reply(cid)
                if reply:
                    client.send_message(cid, reply)
                    log_outgoing(cid, sender, reply)  # ответ Юки → в журнал переписки
                    log("ответ отправлен", cid)
            finally:
                BUSY.discard(cid)
        except Exception as e:  # noqa: BLE001
            log("ошибка обработки:", e)

    start_send_server()  # после старта клиента send_via_app сможет слать
    log("слушаю сообщения…")
    app.run()


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        log("фатальная ошибка:", e)
        sys.exit(1)
