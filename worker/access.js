// /cs-addtoreport @person [@person...] - OWNER approves someone for the Ads mirror from Slack. Each person gets a personal
// mirror link by Slack DM (English + Portuguese) and shows up on the access page, where OWNER can remove them. Nothing is
// automatic: only OWNER can run it. Accepts @mentions (the command escapes them to <@U..|name>), emails (KV "slack_ids"
// {email: user id}, else users.lookupByEmail) or plain names.
import { audit } from "./audit.js";

const MIRROR = "https://slack-translator.auvra-tools.workers.dev/ads/";
export const newToken = () => [...crypto.getRandomValues(new Uint8Array(18))].map((b) => b.toString(16).padStart(2, "0")).join("");

async function slack(env, method, params, get = false) {
  const url = "https://slack.com/api/" + method, auth = { Authorization: "Bearer " + env.SLACK_BOT_TOKEN };
  const r = get ? await fetch(url + "?" + new URLSearchParams(params), { headers: auth })
    : await fetch(url, { method: "POST", body: JSON.stringify(params), headers: { ...auth, "Content-Type": "application/json; charset=utf-8" } });
  const j = await r.json();
  if (!j.ok) throw new Error(`${method}: ${j.error}`);
  return j;
}

// Turns the command text into Slack user ids; anything it can't match comes back in `unknown`.
async function resolve(env, text) {
  const ids = [], unknown = [], words = [];
  for (const m of text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)) ids.push(m[1]);
  for (const w of text.replace(/<@[^>]+>/g, " ").split(/[\s,]+/).filter(Boolean)) words.push(w.replace(/^<mailto:([^|>]+).*>$/, "$1").replace(/^@/, ""));
  const emails = (await env.KB.get("slack_ids", "json")) || {};
  let users = null;
  for (const w of words) {
    if (w.includes("@")) {
      const e = w.toLowerCase();
      const id = emails[e] || await slack(env, "users.lookupByEmail", { email: e }, true).then((j) => j.user.id, () => null);
      id ? ids.push(id) : unknown.push(w); continue;
    }
    if (!users) {   // plain name: match username, display name or real name
      users = []; let cursor = "";
      do { const j = await slack(env, "users.list", { limit: "200", ...(cursor && { cursor }) }, true); users.push(...j.members); cursor = j.response_metadata?.next_cursor; } while (cursor);
    }
    const n = w.toLowerCase(), hit = users.filter((u) => !u.deleted && !u.is_bot && [u.name, u.profile?.display_name, u.profile?.real_name].some((x) => (x || "").toLowerCase() === n));
    hit.length === 1 ? ids.push(hit[0].id) : unknown.push(w + (hit.length > 1 ? " (more than one match, use @mention)" : ""));
  }
  return { ids: [...new Set(ids)], unknown };
}

const first = (name) => name.split(/\s+/)[0].replace(/^./, (c) => c.toUpperCase());
const inviteText = (name, link) =>
  `:bar_chart: *Your Ads Mirror access*\nHi ${first(name)}! You now have your own link to the Ads Mirror: every Auvra ad with Ads Manager's live numbers ` +
  `(spend, CTR, hook rate, CPA, ROAS), read-only and updated every 2 minutes.\n<${link}|Open the Ads Mirror>\nThis link is just for you, please don't share it.\n\n` +
  `:flag-br: *Seu acesso ao Ads Mirror*\nOi ${first(name)}! Agora você tem seu próprio link para o Ads Mirror: todos os anúncios da Auvra com os números ao vivo ` +
  `do Gerenciador de Anúncios (gasto, CTR, hook rate, CPA, ROAS), só para visualizar e atualizado a cada 2 minutos.\n<${link}|Abrir o Ads Mirror>\n` +
  `Este link é só seu, por favor não compartilhe.`;

// Returns the reply OWNER sees (only visible to them).
export async function addToReport(env, text) {
  if (!text.trim()) return "Who should get the Ads Mirror? Use `/cs-addtoreport @person` (you can tag several people, or use their email).";
  const { ids, unknown } = await resolve(env, text);
  const links = (await env.KB.get("mirror_links", "json")) || {};
  const sent = [], already = [], failed = [];
  for (const id of ids) {
    let user;
    try { user = (await slack(env, "users.info", { user: id }, true)).user; } catch { failed.push(`<@${id}>`); continue; }
    const name = user.profile?.real_name || user.real_name || user.name;
    if (user.deleted || user.is_bot) { failed.push(name + (user.is_bot ? " (a bot)" : " (deactivated)")); continue; }
    if (id === env.OWNER || Object.values(links).some((l) => l.slack === id)) { already.push(name); continue; }
    const t = newToken();
    try { await slack(env, "chat.postMessage", { channel: id, text: inviteText(name, MIRROR + t), unfurl_links: false }); }
    catch (e) { failed.push(`${name} (couldn't DM them: ${e.message})`); continue; }
    links[t] = { name, invited: new Date().toISOString(), by: "Rayston via /cs-addtoreport", slack: id };
    await env.KB.put("mirror_links", JSON.stringify(links));   // saved per person, so a later failure never re-sends
    await audit(env, { kind: "mirror_invite", actor_name: "Rayston", text: `approved ${name} for the Ads mirror with /cs-addtoreport (link sent by DM)` });
    sent.push(name);
  }
  const out = [];
  if (sent.length) out.push(`:white_check_mark: Sent an Ads Mirror link by DM to ${sent.join(", ")}.`);
  if (already.length) out.push(`Already has access: ${already.join(", ")}.`);
  if (failed.length) out.push(`:warning: Not sent: ${failed.join(", ")}.`);
  if (unknown.length) out.push(`:grey_question: Couldn't find ${unknown.join(", ")} in Slack. Tag them with @ instead.`);
  out.push("Remove someone any time from Manage access on your mirror.");
  return out.join("\n");
}
