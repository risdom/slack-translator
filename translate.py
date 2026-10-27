#!/usr/bin/env python3
"""translate.py — reply in-channel (thread + feed) with an English translation of every non-English message and
voice/video clip posted in the watched Slack channels since the last run. Free: Google Translate's public web endpoint
(language ID + text), faster-whisper (audio transcription); lingua + Argos Translate as the offline fallback.
Env: SLACK_BOT_TOKEN, TRANSLATE_CHANNELS (JSON {channel_id: name}), OWNER (Slack user ID; their own messages are skipped, TEST_DM=true sends there instead),
     STATE_FILE (default state.json), BACKFILL_MIN (on first run / manual run, look back this many minutes)."""
import os, json, time, tempfile, urllib.request, urllib.parse, urllib.error
TOK=os.environ["SLACK_BOT_TOKEN"]; OWNER=os.environ["OWNER"]
CHANNELS=json.loads(os.environ["TRANSLATE_CHANNELS"])  # {channel_id: channel_name} (or a plain list of IDs)
NAMES=CHANNELS if isinstance(CHANNELS,dict) else {}; STATE=os.environ.get("STATE_FILE","state.json")
BACKFILL=float(os.environ.get("BACKFILL_MIN") or 15); ONLY=os.environ.get("ONLY") or "all"
TEST_DM=os.environ.get("TEST_DM")=="true"   # all | text | audio (manual reruns)

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
print("state file:",os.path.exists(STATE),"| backfill min:",BACKFILL,"| now",time.strftime("%m-%d %H:%M",time.gmtime()))
now=time.time(); todo=[]
for ch in CHANNELS:
    oldest=state.get(ch) or str(now-BACKFILL*60)
    try: resp=slack("conversations.history",channel=ch,oldest=oldest,limit=200); msgs=resp["messages"]
    except RuntimeError as e: print("skip",ch,e); continue
    print(f"  {ch}: since {time.strftime('%m-%d %H:%M',time.gmtime(float(oldest)))}Z got={len(msgs)} from_state={ch in state} echo_oldest={resp.get('oldest')} more={resp.get('has_more')} meta={resp.get('response_metadata')} warn={resp.get('warning')}", flush=True)
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
GOOGLE=["https://translate.googleapis.com/translate_a/single","https://clients5.google.com/translate_a/single"]
def google(text):
    """-> (source language code, English text). Long text goes in paragraph chunks to keep the GET URL short."""
    chunks,cur=[],""
    for para in text.split("\n"):
        if cur and len(cur)+len(para)>1500: chunks.append(cur); cur=""
        cur+=("\n" if cur else "")+para
    chunks.append(cur); src=None; out=[]
    for c in chunks:
        for a in range(4):
            url=GOOGLE[a%2]+"?"+urllib.parse.urlencode({"client":"gtx","sl":"auto","tl":"en","dt":"t","q":c})
            try: r=json.loads(urllib.request.urlopen(urllib.request.Request(url,headers={"User-Agent":"Mozilla/5.0"}),timeout=30).read()); break
            except urllib.error.HTTPError as e:
                if a==3: raise
                time.sleep(3*(a+1))
        src=src or r[2]; out.append("".join(seg[0] for seg in r[0] if seg and seg[0]))
    return src,"\n".join(out)
LANG_NAMES={"pt":"Portuguese","es":"Spanish","fr":"French","it":"Italian","de":"German","nl":"Dutch","ar":"Arabic",
            "ur":"Urdu","hi":"Hindi","tl":"Tagalog","fil":"Filipino","sr":"Serbian","ru":"Russian","tr":"Turkish","id":"Indonesian",
            "zh-CN":"Chinese","zh-TW":"Chinese","ja":"Japanese","ko":"Korean","pl":"Polish","ro":"Romanian","uk":"Ukrainian"}
_argos={}
def argos(text,code):
    import argostranslate.package, argostranslate.translate
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
def to_english(text):
    """-> (language name, English) or None when the text is English / can't be translated."""
    try:
        src,en=google(text)
        if src=="en" or src.startswith("en-"): return None
        return LANG_NAMES.get(src,src),en
    except Exception as e: print("google failed, offline fallback:",e)
    lang=det.detect_language_of(text)
    if not lang or lang==Language.ENGLISH: return None
    en=argos(text,lang.iso_code_639_1.name.lower())
    return (lang.name.title(),en) if en else None
try: print("google check:",google("Olá, tudo bem?"))
except Exception as e: print("google check FAILED (offline fallback in use):",e)
_whisper=None
def audio_to_english(f):
    global _whisper
    from faster_whisper import WhisperModel
    if _whisper is None: _whisper=WhisperModel("small",device="cpu",compute_type="int8")
    url=f.get("url_private_download") or f.get("url_private")
    data=urllib.request.urlopen(urllib.request.Request(url,headers={"Authorization":"Bearer "+TOK}),timeout=300).read()
    with tempfile.NamedTemporaryFile(suffix="."+(f.get("filetype") or "m4a")) as t:
        t.write(data); t.flush()
        segs,info=_whisper.transcribe(t.name,vad_filter=True)          # transcript in the spoken language
        text=" ".join(s.text.strip() for s in segs).strip()
        if not text or info.language=="en": return info.language,text
        try: return info.language,google(text)[1]                      # Google handles names/slang better than Whisper's translate
        except Exception as e: print("google failed on audio, whisper translate:",e)
        segs,_=_whisper.transcribe(t.name,task="translate",vad_filter=True)
        return info.language," ".join(s.text.strip() for s in segs).strip()

names={}
def who(u):
    if u not in names:
        try: p=slack("users.info",user=u)["user"]; names[u]=p.get("real_name") or p.get("name") or u
        except RuntimeError: names[u]=u
    return names[u]

import re
def plain(t):
    """Slack markup -> plain text, so a translation never re-pings anyone or mangles links."""
    t=re.sub(r"<@([UW][A-Z0-9]+)(?:\|[^>]*)?>",lambda x:"@"+who(x.group(1)),t)
    t=re.sub(r"<!(here|channel|everyone)[^>]*>",r"@\1",t)
    t=re.sub(r"<!subteam\^[A-Z0-9]+\|?([^>]*)>",lambda x:x.group(1) or "@group",t)
    t=re.sub(r"<#[A-Z0-9]+\|([^>]*)>",r"#\1",t)
    t=re.sub(r"<(https?://[^|>]+)\|([^>]+)>",r"\2 (\1)",t)
    return re.sub(r"<(https?://[^>]+)>",r"\1",t)

sent=0
for ch,m in todo:
    out=[]; text=plain((m.get("text") or "").strip())
    if ONLY!="audio" and len([c for c in text if c.isalpha()])>=4:
        try: tr=to_english(text)
        except Exception as e: tr=None; print("translate failed",e)
        if tr and tr[1].strip().lower()!=text.lower(): out.append(tr)
    for f in (m.get("files") or []) if ONLY!="text" else []:
        if (f.get("mimetype") or "").startswith(("audio/","video/")) or f.get("subtype") in ("slack_audio","slack_video"):
            try:
                src,en=audio_to_english(f)
                if en: out.append((f"voice clip, spoken {LANG_NAMES.get(src,src)}" if src!="en" else "voice clip, English",en))
            except Exception as e: print("audio failed",e)
    if not out: continue
    esc=lambda t: t.replace("&","&amp;").replace("<","&lt;").replace(">","&gt;")   # no live mentions/links in the reply
    body="\n\n".join(f":globe_with_meridians: *{lbl} → English:*\n>"+esc(en).replace("\n","\n>") for lbl,en in out)
    if TEST_DM:                                                 # manual check: send to the owner's DM instead of the channel
        try: link=slack("chat.getPermalink",channel=ch,message_ts=m["ts"])["permalink"]
        except RuntimeError: link=None
        slack("chat.postMessage","POST",channel=OWNER,unfurl_links=False,
              text=f"[test] would reply in *#{NAMES.get(ch,ch)}* to {who(m['user'])}" + (f" · <{link}|original>" if link else "") + "\n"+body)
    else:                                                       # reply in the message's thread, also shown in the channel feed
        slack("chat.postMessage","POST",channel=ch,thread_ts=m["ts"],reply_broadcast=True,unfurl_links=False,unfurl_media=False,text=body)
    sent+=1
json.dump(state,open(STATE,"w"))
print(f"sent {sent} translation(s)")
