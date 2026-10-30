// Audit log ("security camera") for everything that touches the Auvra Reports bot, stored in D1 (binding AUDIT).
// Records the bot's own posts/edits/deletes wherever they come from (report job, blasts, this Worker), DMs and
// commands sent to it, help-bot Q&A, blocked attempts, Notion sync changes and forged/invalid requests.
// Normal team chat is NOT logged - only bot activity. Rows older than 180 days are pruned nightly.

const FLAG_WORDS = /\b(pass(word)?s?|senha|login|credencia\w*|credential\w*|token|api[ _-]?key|secret|2fa|c[oó]digo|code)\b/i;

export async function audit(env, e) {
  try {
    await env.AUDIT.prepare("INSERT INTO events (ts,kind,actor_id,actor_name,channel_id,channel_name,text,flag) VALUES (?,?,?,?,?,?,?,?)")
      .bind(new Date().toISOString(), e.kind, e.actor_id || null, e.actor_name || null, e.channel_id || null,
            e.channel_name || null, (e.text || "").slice(0, 1500), e.flag || "").run();
  } catch (err) { console.log("audit write failed", String(err)); }
}

// Why a question to the bot deserves a look ("" = routine).
export const askFlag = text => FLAG_WORDS.test(text || "") ? "asked about passwords/logins" : "";

// The bot's own messages arrive as events in every channel/DM it is in: log them so nothing it says goes unseen.
export function botActivity(ev, botUser, appId) {
  const mine = m => m && (m.user === botUser || m.bot_profile?.app_id === appId || m.app_id === appId);
  if (ev.subtype === "message_changed" && mine(ev.message)) return { kind: "bot_edit", text: ev.message.text, flag: "a bot message was edited" };
  if (ev.subtype === "message_deleted" && mine(ev.previous_message)) return { kind: "bot_delete", text: ev.previous_message.text, flag: "a bot message was deleted" };
  if (!ev.subtype || ev.subtype === "bot_message" || ev.subtype === "file_share")
    if (mine(ev)) return { kind: "bot_post", text: ev.text || (ev.files || []).map(f => "[file] " + f.name).join(", ") };
  return null;
}

// Nightly DM to the owner: what the bot did in the last 24 h, and anything flagged.
export async function dailySummary(env, slack) {
  const since = new Date(Date.now() - 864e5).toISOString();
  const { results: counts } = await env.AUDIT.prepare("SELECT kind, COUNT(*) n FROM events WHERE ts >= ? GROUP BY kind ORDER BY n DESC").bind(since).all();
  const { results: flagged } = await env.AUDIT.prepare("SELECT ts,kind,actor_name,channel_name,text,flag FROM events WHERE ts >= ? AND flag != '' ORDER BY ts DESC LIMIT 15").bind(since).all();
  await env.AUDIT.prepare("DELETE FROM events WHERE ts < ?").bind(new Date(Date.now() - 180 * 864e5).toISOString()).run();
  const total = counts.reduce((s, r) => s + r.n, 0);
  const lines = [`:cctv: *Auvra Reports bot - audit for the last 24 h* (${total} events)`,
    counts.map(r => `• ${r.kind.replace("_", " ")}: ${r.n}`).join("\n") || "• no activity"];
  lines.push(flagged.length ? `\n:rotating_light: *${flagged.length} flagged:*` : "\n:white_check_mark: Nothing flagged.");
  for (const f of flagged) {
    const t = new Date(f.ts).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    lines.push(`• ${t} · *${f.flag}* · ${f.actor_name || "?"} in ${f.channel_name || "?"}: _${(f.text || "").replace(/\s+/g, " ").slice(0, 160)}_`);
  }
  if (env.AUDIT_URL) lines.push(`\nFull log: ${env.AUDIT_URL}`);
  await slack(env, "chat.postMessage", { channel: env.OWNER, unfurl_links: false, text: lines.join("\n") });
}

// GET /audit?key=...&days=N -> JSON rows, for the audit artifact page. Key = AUDIT_KEY secret.
export async function auditApi(req, env) {
  const u = new URL(req.url), key = u.searchParams.get("key") || "";
  const ok = env.AUDIT_KEY && key.length === env.AUDIT_KEY.length && [...key].reduce((d, c, i) => d | (c.charCodeAt(0) ^ env.AUDIT_KEY.charCodeAt(i)), 0) === 0;
  if (!ok) { await audit(env, { kind: "bad_signature", text: "wrong audit key from " + (req.headers.get("cf-connecting-ip") || "?"), flag: "someone tried to read the audit log" }); return new Response("forbidden", { status: 403 }); }
  const days = Math.min(180, Number(u.searchParams.get("days")) || 30);
  const { results } = await env.AUDIT.prepare("SELECT id,ts,kind,actor_id,actor_name,channel_id,channel_name,text,flag FROM events WHERE ts >= ? ORDER BY ts DESC LIMIT 5000")
    .bind(new Date(Date.now() - days * 864e5).toISOString()).all();
  return new Response(JSON.stringify(results), { headers: { "content-type": "application/json" } });
}
