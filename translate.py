#!/usr/bin/env python3
"""translate.py — DM the owner an English translation of every non-English message and voice/video clip
posted in the watched Slack channels since the last run. Free, local models only:
lingua (language ID), Argos Translate (text), faster-whisper task=translate (audio).
Env: SLACK_BOT_TOKEN, TRANSLATE_CHANNELS (JSON list of channel IDs), OWNER (Slack user ID to DM),
     STATE_FILE (default state.json), BACKFILL_MIN (on first run / manual run, look back this many minutes)."""
import os, json, time, tempfile, urllib.request, urllib.parse
TOK=os.environ["SLACK_BOT_TOKEN"]; OWNER=os.environ["OWNER"]
CHANNELS=json.loads(os.environ["TRANSLATE_CHANNELS"]); STATE=os.environ.get("STATE_FILE","state.json")
BACKFILL=float(os.environ.get("BACKFILL_MIN") or 15)

def slack(method,http="GET",**p):
    url="https://slack.com/api/"+method; hdr={"Authorization":"Bearer "+TOK}
    if http=="GET": req=urllib.request.Request(url+"?"+urllib.parse.urlencode(p),headers=hdr)
    else: req=urllib.request.Request(url,data=json.dumps(p).encode(),headers={**hdr,"Content-Type":"application/json; charset=utf-8"})
    for a in range(5):
        r=json.loads(urllib.request.urlopen(req,timeout=60).read())
        if r.get("error")=="ratelimited": time.sleep(5*(a+1)); continue
        if not r.get("ok"): raise RuntimeError(f"{method}: {r.get('error')}")
        return r

state=json.load(open(STATE)) if os.path.exists(STATE) else {}
now=time.time(); todo=[]
for ch in CHANNELS:
    oldest=state.get(ch) or str(now-BACKFILL*60)
    try: msgs=slack("conversations.history",channel=ch,oldest=oldest,limit=200)["messages"]
    except RuntimeError as e: print("skip",ch,e); continue
    if os.environ.get("DEBUG"): print(f"  {ch}: oldest={oldest} got={len(msgs)}")
    for m in reversed(msgs):                                   # oldest first
        if m.get("user") in (None,OWNER) or m.get("bot_id") or m.get("subtype") in ("channel_join","channel_leave","bot_message"): continue
        todo.append((ch,m))
    if msgs: state[ch]=max(m["ts"] for m in msgs)
    elif ch not in state: state[ch]=str(now)
print(f"{len(todo)} new human messages across {len(CHANNELS)} channels")

from lingua import Language, LanguageDetectorBuilder
LANGS=[Language.ENGLISH,Language.PORTUGUESE,Language.FRENCH,Language.SPANISH,Language.ITALIAN,Language.GERMAN,
       Language.DUTCH,Language.ARABIC,Language.URDU,Language.HINDI,Language.TAGALOG,Language.SERBIAN,Language.RUSSIAN,
       Language.TURKISH,Language.INDONESIAN,Language.CHINESE]
det=LanguageDetectorBuilder.from_languages(*LANGS).with_minimum_relative_distance(0.15).build()
_argos={}
def to_english(text,lang):
    import argostranslate.package, argostranslate.translate
    code=lang.iso_code_639_1.name.lower()
    if code not in _argos:
        argostranslate.package.update_package_index()
        pk=[p for p in argostranslate.package.get_available_packages() if p.from_code==code and p.to_code=="en"]
        if not pk: _argos[code]=None
        else:
            if not any(p.from_code==code and p.to_code=="en" for p in argostranslate.package.get_installed_packages()):
                argostranslate.package.install_from_path(pk[0].download())
            _argos[code]=True
    if not _argos[code]: return None
    return argostranslate.translate.translate(text,code,"en")
_whisper=None
def audio_to_english(f):
    global _whisper
    from faster_whisper import WhisperModel
    if _whisper is None: _whisper=WhisperModel("small",device="cpu",compute_type="int8")
    url=f.get("url_private_download") or f.get("url_private")
    data=urllib.request.urlopen(urllib.request.Request(url,headers={"Authorization":"Bearer "+TOK}),timeout=300).read()
    with tempfile.NamedTemporaryFile(suffix="."+(f.get("filetype") or "m4a")) as t:
        t.write(data); t.flush()
        segs,info=_whisper.transcribe(t.name,task="translate",vad_filter=True)
        text=" ".join(s.text.strip() for s in segs).strip()
    return info.language,text

names={}
def who(u):
    if u not in names:
        try: p=slack("users.info",user=u)["user"]; names[u]=p.get("real_name") or p.get("name") or u
        except RuntimeError: names[u]=u
    return names[u]

sent=0
for ch,m in todo:
    out=[]; text=(m.get("text") or "").strip()
    if len([c for c in text if c.isalpha()])>=4:
        lang=det.detect_language_of(text)
        if lang and lang!=Language.ENGLISH:
            try: en=to_english(text,lang)
            except Exception as e: en=None; print("translate failed",e)
            if en and en.strip().lower()!=text.lower(): out.append((lang.name.title(),en))
    for f in m.get("files") or []:
        if (f.get("mimetype") or "").startswith(("audio/","video/")) or f.get("subtype") in ("slack_audio","slack_video"):
            try:
                src,en=audio_to_english(f)
                if en: out.append((f"voice clip, spoken {src}" if src!="en" else "voice clip, English",en))
            except Exception as e: print("audio failed",e)
    if not out: continue
    try: link=slack("chat.getPermalink",channel=ch,message_ts=m["ts"])["permalink"]
    except RuntimeError: link=None
    chan=slack("conversations.info",channel=ch)["channel"]["name"]
    body="\n\n".join(f"*{lbl} → English:*\n>{en.replace(chr(10),chr(10)+'>')}" for lbl,en in out)
    slack("chat.postMessage","POST",channel=OWNER,unfurl_links=False,
          text=f":globe_with_meridians: *#{chan}* · {who(m['user'])}" + (f" · <{link}|original>" if link else "") + "\n"+body)
    sent+=1
json.dump(state,open(STATE,"w"))
print(f"sent {sent} translation(s)")
