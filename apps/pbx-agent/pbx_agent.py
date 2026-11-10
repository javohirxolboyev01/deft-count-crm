#!/usr/bin/env python3
"""
pbx-agent: Asterisk CDR faylidan (cdr_csv, Master.csv) yangi qatorlarni CRM'ga yuboradi.

Ofisdagi Asterisk serverida ishlaydi. Faqat chiquvchi HTTPS: serverda port ochilmaydi, Asterisk konfiguratsiyasi
o'zgartirilmaydi. Faqat Python 3.8+ standart kutubxonasi (pip kerak emas).

Sozlamalar (muhit o'zgaruvchilari, odatda /etc/pbx-agent.env):
  CRM_URL           https://crm.example.uz            (majburiy)
  PBX_INGEST_TOKEN  CRM'dagi PBX_INGEST_TOKEN bilan bir xil (majburiy)
  CDR_FILE          /var/log/asterisk/cdr-csv/Master.csv
  STATE_FILE        /var/lib/pbx-agent/state.json   (fayldagi qaysi joygacha yuborilgani)
  POLL_SEC          5
  CDR_COLUMNS       ustunlar nomi vergul bilan (bo'sh = cdr_csv standarti, ustunlar soniga qarab)
  REC_DIR           /var/spool/asterisk/monitor     (audio yozuvlar papkasi, ichki papkalari bilan; bo'sh = o'chiq)
  REC_STATE_FILE    /var/lib/pbx-agent/recordings.json (qaysi yozuvlar yuborilgani)
  REC_SINCE         2026-01-01   (shu sanadan eski yozuvlar yuborilmaydi; bo'sh = hammasi)

Audio: serverda ffmpeg bo'lsa yozuv OGG/Opus'ga siqiladi (soatiga ~10 MB), bo'lmasa asl fayl yuboriladi
(WAV soatiga ~60 MB; 50 MB dan kattasi Telegramga sig'maydi). Yozuvlar serverdan o'chirilmaydi.

Tekshirish:  python3 pbx_agent.py --dry-run      (oxirgi 5 qatorni qanday tushunganini ko'rsatadi, yubormaydi)
Tarixsiz:    python3 pbx_agent.py --from-end     (birinchi ishga tushishda eski qatorlarni o'tkazib yuboradi)
"""
import csv
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.error
import urllib.request

BASE_COLUMNS = [
    "accountcode", "src", "dst", "dcontext", "clid", "channel", "dstchannel", "lastapp", "lastdata",
    "start", "answer", "end", "duration", "billsec", "disposition", "amaflags",
]
BATCH = 200
HEARTBEAT_SEC = 60
AUDIO_MIME = {".wav": "audio/wav", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".gsm": "audio/x-gsm", ".wav49": "audio/wav"}
REC_MAX_BYTES = 50 * 1024 * 1024   # Telegram Bot API yuklash chegarasi
REC_MIN_AGE_SEC = 120              # hali yozilayotgan faylga tegilmaydi
REC_SCAN_SEC = 30
REC_PACE_SEC = 3.5                 # Telegram kanalga ~20 xabar/daqiqa chegarasi


def log(msg):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), msg, flush=True)


def columns_for(n, override):
    """cdr.conf [csv]: loguniqueid=yes -> +uniqueid, loguserfield=yes -> +userfield"""
    if override:
        return override
    if n <= 16:
        return BASE_COLUMNS[:n]
    if n == 17:
        return BASE_COLUMNS + ["uniqueid"]
    return BASE_COLUMNS + ["uniqueid", "userfield"] + ["extra%d" % i for i in range(n - 18)]


def parse_line(raw, override):
    text = raw.decode("utf-8", errors="replace").rstrip("\r\n")
    if not text.strip():
        return None
    row = next(csv.reader(io.StringIO(text)), None)
    if not row:
        return None
    cols = columns_for(len(row), override)
    fields = {c: v for c, v in zip(cols, row) if not c.startswith("extra")}
    return {"key": hashlib.sha1(raw.rstrip(b"\r\n")).hexdigest(), "fields": fields}


class Agent:
    def __init__(self):
        self.url = os.environ.get("CRM_URL", "").rstrip("/") + "/api/calls/ingest"
        self.token = os.environ.get("PBX_INGEST_TOKEN", "")
        self.cdr = os.environ.get("CDR_FILE", "/var/log/asterisk/cdr-csv/Master.csv")
        self.state_file = os.environ.get("STATE_FILE", "/var/lib/pbx-agent/state.json")
        self.poll = float(os.environ.get("POLL_SEC", "5"))
        cols = os.environ.get("CDR_COLUMNS", "").strip()
        self.override = [c.strip() for c in cols.split(",")] if cols else None
        self.state = self.load_state()
        self.last_sent = 0.0

    def load_state(self):
        try:
            with open(self.state_file) as f:
                return json.load(f)
        except (OSError, ValueError):
            return None

    def save_state(self):
        os.makedirs(os.path.dirname(self.state_file) or ".", exist_ok=True)
        tmp = self.state_file + ".tmp"
        with open(tmp, "w") as f:
            json.dump(self.state, f)
        os.replace(tmp, self.state_file)

    def post(self, records):
        body = json.dumps({"records": records}).encode()
        req = urllib.request.Request(
            self.url, data=body, method="POST",
            headers={"Content-Type": "application/json", "Authorization": "Bearer " + self.token,
                     "User-Agent": "pbx-agent/1"},
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            self.last_sent = time.time()
            return json.loads(r.read() or b"{}")

    def read_new(self):
        """Oxirgi joydan to'liq qatorlar (yarim yozilgan oxirgi qator keyingi safar)"""
        with open(self.cdr, "rb") as f:
            f.seek(self.state["offset"])
            data = f.read(4 * 1024 * 1024)
        end = data.rfind(b"\n")
        if end < 0:
            return [], 0
        chunk = data[: end + 1]
        return chunk.splitlines(keepends=True), len(chunk)

    def tick(self):
        try:
            st = os.stat(self.cdr)
        except FileNotFoundError:
            return False
        if self.state is None:
            self.state = {"inode": st.st_ino, "offset": st.st_size if "--from-end" in sys.argv else 0}
            self.save_state()
        # logrotate: yangi fayl yoki qisqargan fayl -> boshidan
        if st.st_ino != self.state["inode"] or st.st_size < self.state["offset"]:
            log("CDR fayli almashgan, boshidan o'qiladi")
            self.state = {"inode": st.st_ino, "offset": 0}
            self.save_state()
        if st.st_size == self.state["offset"]:
            return False
        lines, consumed = self.read_new()
        if not lines:
            return False
        for i in range(0, len(lines), BATCH):
            part = lines[i:i + BATCH]
            records = [r for r in (parse_line(l, self.override) for l in part) if r]
            try:
                res = self.post(records) if records else {}
            except urllib.error.HTTPError as e:
                detail = e.read()[:500].decode("utf-8", "replace")
                if e.code == 400:
                    # Buzilgan paket abadiy to'xtatib qo'ymasin: log qilinadi va o'tkaziladi
                    log("CRM paketni qabul qilmadi (400), o'tkazildi: %s" % detail)
                else:
                    raise
            else:
                if records:
                    log("yuborildi: %s" % res)
            self.state["offset"] += sum(len(l) for l in part)
            self.save_state()
        # 4 MB'dan ko'p yangi ma'lumot bo'lsa (birinchi ishga tushish) — kutmasdan davom etadi
        return consumed >= 4 * 1024 * 1024 - 65536

    def run(self):
        if not self.token or self.url.startswith("/api"):
            sys.exit("CRM_URL va PBX_INGEST_TOKEN sozlanmagan")
        log("ishga tushdi: %s -> %s" % (self.cdr, self.url))
        if os.environ.get("REC_DIR", "/var/spool/asterisk/monitor").strip():
            Recorder(self.url[: -len("/api/calls/ingest")], self.token).start()
        delay = self.poll
        while True:
            try:
                more = self.tick()
                if time.time() - self.last_sent > HEARTBEAT_SEC:
                    self.post([])  # CRM'da "aloqa bor" belgisi
                delay = self.poll
                if more:
                    continue
            except urllib.error.HTTPError as e:
                log("CRM xatosi %s: %s" % (e.code, e.read()[:300].decode("utf-8", "replace")))
                delay = min(delay * 2, 300)
            except (urllib.error.URLError, OSError, TimeoutError) as e:
                log("aloqa yo'q: %s" % e)
                delay = min(delay * 2, 300)
            time.sleep(delay)


class Recorder(threading.Thread):
    """Audio yozuvlarni CRM'ga yuboradi (CRM ularni Telegram yopiq kanaliga saqlaydi). Alohida oqim: ko'p yozuvli
    navbat (birinchi ishga tushish) CDR yuborishni to'xtatib qo'ymasin."""

    def __init__(self, base, token):
        super().__init__(daemon=True)
        self.dir = os.environ.get("REC_DIR", "/var/spool/asterisk/monitor").rstrip("/")
        self.url = base + "/api/calls/recordings"
        self.token = token
        self.state_file = os.environ.get("REC_STATE_FILE", "/var/lib/pbx-agent/recordings.json")
        since = os.environ.get("REC_SINCE", "").strip()
        self.since = time.mktime(time.strptime(since, "%Y-%m-%d")) if since else 0
        self.ffmpeg = shutil.which("ffmpeg")
        self.done = self.load()

    def load(self):
        try:
            with open(self.state_file) as f:
                return json.load(f)
        except (OSError, ValueError):
            return {}

    def save(self):
        os.makedirs(os.path.dirname(self.state_file) or ".", exist_ok=True)
        tmp = self.state_file + ".tmp"
        with open(tmp, "w") as f:
            json.dump(self.done, f)
        os.replace(tmp, self.state_file)

    def pending(self):
        now = time.time()
        out = []
        for root, _dirs, files in os.walk(self.dir):
            for name in files:
                full = os.path.join(root, name)
                rel = os.path.relpath(full, self.dir)
                ext = os.path.splitext(name)[1].lower()
                if ext not in AUDIO_MIME or rel in self.done:
                    continue
                try:
                    mtime = os.stat(full).st_mtime
                except OSError:
                    continue
                if mtime > now - REC_MIN_AGE_SEC or mtime < self.since:
                    continue
                out.append((mtime, rel, full, ext))
        return sorted(out)

    def encode(self, full, ext):
        """(bayt, mime, nom kengaytmasi). ffmpeg bo'lsa — mono Opus 24 kbit/s (nutq uchun yetarli)"""
        if self.ffmpeg and ext not in (".ogg", ".mp3"):
            with tempfile.NamedTemporaryFile(suffix=".ogg") as tmp:
                r = subprocess.run(
                    [self.ffmpeg, "-nostdin", "-loglevel", "error", "-y", "-i", full,
                     "-ac", "1", "-c:a", "libopus", "-b:a", "24k", "-application", "voip", tmp.name],
                    capture_output=True, timeout=600,
                )
                if r.returncode == 0:
                    with open(tmp.name, "rb") as f:
                        return f.read(), "audio/ogg", ".ogg"
                log("ffmpeg xatosi, asl fayl yuboriladi: %s" % r.stderr[:300].decode("utf-8", "replace"))
        with open(full, "rb") as f:
            return f.read(), AUDIO_MIME[ext], ext

    def send(self, rel, full, ext):
        data, mime, new_ext = self.encode(full, ext)
        if len(data) > REC_MAX_BYTES:
            log("yozuv 50 MB dan katta, yuborilmadi (serverda qoladi): %s" % rel)
            return {"skipped": "too_large"}
        name = os.path.splitext(os.path.basename(rel))[0] + new_ext
        req = urllib.request.Request(
            self.url, data=data, method="POST",
            headers={"Content-Type": mime, "Authorization": "Bearer " + self.token, "User-Agent": "pbx-agent/1",
                     "X-Source-Path": urllib.parse.quote(rel), "X-File-Name": urllib.parse.quote(name)},
        )
        with urllib.request.urlopen(req, timeout=300) as r:
            return json.loads(r.read() or b"{}")

    def run(self):
        if not os.path.isdir(self.dir):
            log("yozuvlar papkasi topilmadi, audio yuborilmaydi: %s" % self.dir)
            return
        log("audio yozuvlar: %s (ffmpeg: %s)" % (self.dir, "bor" if self.ffmpeg else "yo'q, asl fayl yuboriladi"))
        delay = REC_SCAN_SEC
        while True:
            try:
                for _mtime, rel, full, ext in self.pending():
                    try:
                        res = self.send(rel, full, ext)
                    except urllib.error.HTTPError as e:
                        if e.code not in (400, 413):
                            raise
                        res = {"rejected": e.code, "detail": e.read()[:200].decode("utf-8", "replace")}
                        log("CRM yozuvni qabul qilmadi: %s %s" % (rel, res))
                    self.done[rel] = res.get("id") or res.get("skipped") or res.get("rejected") or True
                    self.save()
                    if "id" in res:
                        log("yozuv yuborildi: %s" % rel)
                    time.sleep(REC_PACE_SEC)
                delay = REC_SCAN_SEC
            except urllib.error.HTTPError as e:
                log("CRM xatosi (yozuv) %s: %s" % (e.code, e.read()[:300].decode("utf-8", "replace")))
                delay = min(delay * 2, 600)
            except (urllib.error.URLError, OSError, TimeoutError, subprocess.SubprocessError) as e:
                log("yozuv yuborilmadi: %s" % e)
                delay = min(delay * 2, 600)
            time.sleep(delay)


def dry_run():
    path = os.environ.get("CDR_FILE", "/var/log/asterisk/cdr-csv/Master.csv")
    cols = os.environ.get("CDR_COLUMNS", "").strip()
    override = [c.strip() for c in cols.split(",")] if cols else None
    with open(path, "rb") as f:
        lines = f.readlines()[-5:]
    for l in lines:
        print(json.dumps(parse_line(l, override), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    if "--dry-run" in sys.argv:
        dry_run()
    else:
        Agent().run()
