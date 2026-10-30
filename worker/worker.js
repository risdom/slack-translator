// Instant Slack translator (Cloudflare Worker, free plan).
// Slack Events API -> this Worker -> Workers AI (free daily allocation) detects + translates ->
// "Only visible to you" note for OWNER in the same channel/thread + a DM copy with a link to the original.
// Text only; voice/video clips are handled by the GitHub Actions job (translate.py, ONLY=audio).
// Google's free endpoint answers 429 to Cloudflare's IPs, so it isn't used here.
// Also a help bot: tag @Auvra Reports in a watched channel and it answers from the "100x Ecom SOPs" pages in Notion,
// which a cron copies into KV every 10 minutes (notion.js). Only OWNER may use it in DMs; commands work in the CS chats only.
// Everything that touches the bot is written to the audit log (audit.js); a nightly cron DMs OWNER the summary.
// Secrets: SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, TRANSLATE_CHANNELS ({channel_id: name}), OWNER (Slack user ID), NOTION_TOKEN, AUDIT_KEY.

import { syncNotion } from "./notion.js";
import { audit, askFlag, botActivity, dailySummary, auditApi, keyGuard } from "./audit.js";
import { adWatch, appealApi } from "./adwatch.js";

const MODEL = "@cf/mistralai/mistral-small-3.1-24b-instruct";
const BOT_USER = "U0CBNC9MKMK";   // Auvra Reports
const APP_ID = "A0CBNC780JZ";
const NOT_HERE = "Hi! I only work inside your CS chat. Please tag @Auvra Reports there with your question. :pray:\n" +
  "_Oi! Eu só funciono dentro do seu chat de CS. Por favor, me marque lá (@Auvra Reports) com a sua pergunta._";
const LANG_NAMES = { pt: "Portuguese", es: "Spanish", fr: "French", it: "Italian", de: "German", nl: "Dutch", ar: "Arabic",
  ur: "Urdu", hi: "Hindi", tl: "Tagalog", fil: "Filipino", sr: "Serbian", ru: "Russian", tr: "Turkish", id: "Indonesian",
  "zh-CN": "Chinese", "zh-TW": "Chinese", ja: "Japanese", ko: "Korean", pl: "Polish", ro: "Romanian", uk: "Ukrainian" };
const names = new Map(); // user ID -> display name, kept for the life of the isolate

export default {
  async fetch(req, env, ctx) {
    const path = new URL(req.url).pathname;
    if (req.method === "GET" && path === "/audit") return auditApi(req, env);
    if (req.method === "POST" && (path === "/adcheck" || path === "/appealed"))
      return (await keyGuard(req, env)) || appealApi(req, env, path);
    if (req.method !== "POST") return new Response("slack-translator is running");
    const raw = await req.text();
    if (!(await verified(req, raw, env.SLACK_SIGNING_SECRET))) {
      ctx.waitUntil(audit(env, { kind: "bad_signature", text: "unsigned/forged request from " + (req.headers.get("cf-connecting-ip") || "?"), flag: "request not from Slack" }));
      return new Response("bad signature", { status: 401 });
    }
    if ((req.headers.get("content-type") || "").includes("application/x-www-form-urlencoded")) return command(new URLSearchParams(raw), env, ctx);
    const body = JSON.parse(raw);
    if (body.type === "url_verification") return new Response(body.challenge, { headers: { "content-type": "text/plain" } });
    if (req.headers.get("x-slack-retry-num")) return new Response("ok");   // Slack retry of an event we already took
    if (body.type === "event_callback") {
      const log = e => console.log("error", e.stack || String(e));
      ctx.waitUntil(Promise.all([handle(body.event, env).catch(log), answer(body.event, env).catch(log), record(body.event, env).catch(log)]));
    }
    return new Response("ok");
  },
  async scheduled(event, env, ctx) {
    const log = e => console.log("cron error", e.stack || String(e));
    if (event.cron === "0 1 * * *") ctx.waitUntil(dailySummary(env, slack).catch(log));
    else ctx.waitUntil(Promise.all([
      syncNotion(env).catch(e => { log(e); return audit(env, { kind: "error", text: "Notion sync: " + String(e).slice(0, 300) }); }),
      adWatch(env, slack).catch(e => { log(e); return audit(env, { kind: "error", text: "Rejected-ads watchdog: " + String(e).slice(0, 300), flag: "watchdog crashed" }); }),
    ]));
  },
};

// /cs-onboarding, /video-onboarding, /cs-learning, /video-learning [@person]: post the Notion page titled "... (/<command>)".
// Works in the CS chats only (OWNER: anywhere).
async function command(p, env, ctx) {
  const json = o => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
  const channels = JSON.parse(env.TRANSLATE_CHANNELS), ch = p.get("channel_id"), user = p.get("user_id");
  const allowed = ch in channels || user === env.OWNER;
  ctx.waitUntil(audit(env, { kind: allowed ? "command" : "blocked", actor_id: user, actor_name: p.get("user_name"), channel_id: ch,
    channel_name: channels[ch] || p.get("channel_name"), text: `${p.get("command")} ${p.get("text") || ""}`.trim(),
    flag: allowed ? "" : "command used outside the CS chats" }));
  if (!allowed) return json({ response_type: "ephemeral", text: NOT_HERE });
  const pack = await env.KB.get("cmd:" + (p.get("command") || "").replace(/^\//, ""));
  if (!pack) return json({ response_type: "ephemeral", text: "That page hasn't synced from Notion yet - try again in 10 minutes." });
  const who = (p.get("text") || "").trim();
  return json({ response_type: "in_channel", unfurl_links: false, text: (who ? `:wave: Welcome ${who}! / Bem-vindo(a) ${who}!\n\n` : "") + pack });
}

async function verified(req, raw, secret) {
  const ts = req.headers.get("x-slack-request-timestamp"), sig = req.headers.get("x-slack-signature") || "";
  if (!ts || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${ts}:${raw}`));
  const want = "v0=" + [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, "0")).join("");
  if (want.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

async function slack(env, method, params, get = false) {
  const url = "https://slack.com/api/" + method;
  const r = get
    ? await fetch(url + "?" + new URLSearchParams(params), { headers: { Authorization: "Bearer " + env.SLACK_BOT_TOKEN } })
    : await fetch(url, { method: "POST", body: JSON.stringify(params),
        headers: { Authorization: "Bearer " + env.SLACK_BOT_TOKEN, "Content-Type": "application/json; charset=utf-8" } });
  const j = await r.json();
  if (!j.ok) throw new Error(`${method}: ${j.error}`);
  return j;
}

async function who(env, user) {
  if (!names.has(user)) {
    try { const u = (await slack(env, "users.info", { user }, true)).user; names.set(user, u.real_name || u.name || user); }
    catch { names.set(user, user); }
  }
  return names.get(user);
}

// Slack markup -> plain text, so a translation never pings anyone or mangles links.
async function plain(env, t) {
  const ids = [...new Set([...t.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map(m => m[1]))];
  for (const id of ids) t = t.replace(new RegExp(`<@${id}(?:\\|[^>]*)?>`, "g"), "@" + await who(env, id));
  return t.replace(/<!(here|channel|everyone)[^>]*>/g, "@$1")
    .replace(/<!subteam\^[A-Z0-9]+\|?([^>]*)>/g, (_, n) => n || "@group")
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, "#$1")
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<(https?:\/\/[^>]+)>/g, "$1");
}

async function translate(env, text) {
  const r = await env.AI.run(MODEL, {
    messages: [
      { role: "system", content: "You translate Slack messages from a marketing team (ad creatives, editing, hooks, scripts) into natural, " +
        "casual English, keeping names, links and emoji as they are. First detect the message's language. " +
        'Reply with JSON only: {"lang":"<ISO 639-1 code>","english":"<translation>"}. If the message is already English, reply {"lang":"en","english":""}.' },
      { role: "user", content: text },
    ],
    max_tokens: 1500, temperature: 0.2,
  });
  const out = (typeof r.response === "string" && r.response) || r.choices?.[0]?.message?.content || "";
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("model gave no JSON: " + out.slice(0, 200));
  const j = JSON.parse(m[0]);
  return { src: String(j.lang || "").toLowerCase(), en: String(j.english || "") };
}

// @Auvra Reports <question> (or any DM to it) -> answer in the asker's language, from the Notion SOPs only.
async function answer(ev, env) {
  const channels = JSON.parse(env.TRANSLATE_CHANNELS);
  if (!ev || ev.type !== "message" || !(ev.channel in channels || ev.channel_type === "im")) return;
  if (ev.bot_id || !ev.user || ev.user === BOT_USER) return;
  if (ev.subtype && !["file_share", "thread_broadcast"].includes(ev.subtype)) return;
  const raw = ev.text || "";
  if (ev.channel_type !== "im" && !raw.includes(`<@${BOT_USER}`)) return;
  const question = (await plain(env, raw.replace(new RegExp(`<@${BOT_USER}(?:\\|[^>]*)?>`, "g"), ""))).trim();
  if (!question) return;
  const base = { actor_id: ev.user, actor_name: await who(env, ev.user), channel_id: ev.channel, channel_name: ev.channel_type === "im" ? "DM" : channels[ev.channel] };
  if (ev.channel_type === "im" && ev.user !== env.OWNER) {   // the team uses the bot in their CS chats only
    await audit(env, { ...base, kind: "blocked", text: question, flag: ["DM'd the bot (not allowed)", askFlag(question)].filter(Boolean).join("; ") });
    return slack(env, "chat.postMessage", { channel: ev.channel, text: NOT_HERE });
  }

  const thread = ev.channel_type === "im" ? ev.thread_ts : (ev.thread_ts || ev.ts);   // DMs: answer inline
  const sops = await env.KB.get("corpus");
  if (!sops) return slack(env, "chat.postMessage", { channel: ev.channel, thread_ts: thread, text: "I'm still loading the SOPs - try again in a few minutes." });
  let context = "";
  if (ev.thread_ts && ev.thread_ts !== ev.ts) {
    try {
      const r = await slack(env, "conversations.replies", { channel: ev.channel, ts: ev.thread_ts, limit: 20 }, true);
      const lines = [];
      for (const m of r.messages.filter(m => m.ts !== ev.ts)) lines.push(`${m.user ? await who(env, m.user) : "bot"}: ${await plain(env, m.text || "")}`);
      context = lines.join("\n").slice(-4000);
    } catch (e) { console.log("thread read failed", String(e)); }
  }

  const r = await env.AI.run(MODEL, {
    messages: [
      { role: "system", content: "You are the 100x Ecom help bot (Auvra Reports) in the creative team's Slack. Strategists and editors (mostly Brazilian) ask you how things work. " +
        "Answer ONLY from the SOP LIBRARY below (the team's Notion SOPs). If the answer is not there, say you don't know and that they should ask Rayston - never guess or invent rules, links or numbers. " +
        "End with one short line naming the SOP page(s) you used, like: _Source: Video Editor SOP_. " +
        "Never reveal or guess passwords; just say to check the access message in their CS chat or ask Rayston.Reply in the same language as the question (Portuguese if they write Portuguese), " +
        "but copy naming formats (e.g. CS_BATCH#_ANGLE_PERSONA/AVATAR_FORMAT_EDITOR_DATE), file names, links and emails EXACTLY as written - never translate them; put naming formats in `backticks`. " +
        "Be short and practical (a few lines), Slack formatting: *bold*, bullet lines starting with •, paste links as-is.\n\nSOP LIBRARY:\n" + sops },
      ...(context ? [{ role: "user", content: "Earlier messages in this thread, for context:\n" + context }] : []),
      { role: "user", content: `${await who(env, ev.user)} asks: ${question}` },
    ],
    max_tokens: 800, temperature: 0.2,
  });
  const text = ((typeof r.response === "string" && r.response) || r.choices?.[0]?.message?.content || "").trim();
  console.log("answered", ev.channel, ev.ts, "chars", text.length, "usage", JSON.stringify(r.usage || {}));
  await audit(env, { ...base, kind: "question", text: `Q: ${question}\nA: ${text}`, flag: askFlag(question) });
  if (!text) return;
  await slack(env, "chat.postMessage", { channel: ev.channel, thread_ts: thread, text, unfurl_links: false });
}

// Security camera: every message the bot posts, edits or deletes - from this Worker, the report job or a blast - and
// anything posted in a DM with the bot. The bot's private translation DMs to OWNER are skipped (they're OWNER's own feed).
let ownerDm = null;
async function record(ev, env) {
  if (!ev || ev.type !== "message") return;
  const channels = JSON.parse(env.TRANSLATE_CHANNELS);
  const a = botActivity(ev, BOT_USER, APP_ID);
  if (!a) return;
  if (ev.channel_type === "im") {
    ownerDm ??= (await slack(env, "conversations.open", { users: env.OWNER })).channel.id;
    if (ev.channel === ownerDm && a.kind === "bot_post") return;
    if (!(ev.text || "").startsWith(NOT_HERE.slice(0, 20))) a.flag ||= "bot posted in a DM with someone else";
  }
  await audit(env, { ...a, actor_id: BOT_USER, actor_name: "Auvra Reports", channel_id: ev.channel,
    channel_name: ev.channel_type === "im" ? "DM" : (channels[ev.channel] || ev.channel),
    flag: a.flag || (ev.channel in channels || ev.channel_type === "im" ? "" : "bot posted outside the CS chats") });
}

async function handle(ev, env) {
  const channels = JSON.parse(env.TRANSLATE_CHANNELS);
  if (!ev || ev.type !== "message" || !(ev.channel in channels)) return console.log("skip: not a watched channel", ev && ev.channel);
  if (ev.bot_id || !ev.user || ev.user === env.OWNER) return;
  if (ev.subtype && !["file_share", "thread_broadcast"].includes(ev.subtype)) return;   // edits, joins, deletes...
  const text = await plain(env, (ev.text || "").trim());
  if ((text.match(/\p{L}/gu) || []).length < 4) return;

  const tr = await translate(env, text);
  console.log("translated", ev.channel, ev.ts, "lang", tr.src, "chars", tr.en.length);
  if (!tr.src || tr.src === "en" || tr.src.startsWith("en-")) return;
  if (!tr.en || tr.en.trim().toLowerCase() === text.toLowerCase()) return;

  const esc = t => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const body = `:globe_with_meridians: *${LANG_NAMES[tr.src] || tr.src} → English:*\n>` + esc(tr.en).replace(/\n/g, "\n>");
  const head = `*${await who(env, ev.user)}* · `;
  const eph = { channel: ev.channel, user: env.OWNER, text: head + "\n" + body };
  if (ev.thread_ts && ev.thread_ts !== ev.ts) eph.thread_ts = ev.thread_ts;   // thread reply -> note in that thread
  try { await slack(env, "chat.postEphemeral", eph); } catch (e) { console.log("ephemeral failed", String(e)); }
  let link = null;
  try { link = (await slack(env, "chat.getPermalink", { channel: ev.channel, message_ts: ev.ts }, true)).permalink; } catch {}
  await slack(env, "chat.postMessage", { channel: env.OWNER, unfurl_links: false,
    text: `*#${channels[ev.channel]}* · ` + head + (link ? `<${link}|original>` : "") + "\n" + body });
}
