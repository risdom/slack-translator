// Automatic Ads mirror access from the company roster. Everyone whose Creative HQ role is in KV "mirror_roles" (default:
// strategist) gets a personal mirror link by Slack DM; when they lose that role, leave Creative HQ, or their Slack account
// is deactivated, the link is revoked. Runs on the 10-minute cron, only while KV "mirror_auto" is "on" (otherwise it just
// stores the plan in KV "mirror_auto_plan" for the admin page). Creative HQ is read with secret CHQ_KEY. Slack IDs come
// from KV "slack_ids" {email: user id} (seeded from the CS channels) or users.lookupByEmail (needs users:read.email).
// Links made by hand on the admin page are never touched; people OWNER removes go on KV "mirror_blocked" so they stay removed.
import { audit } from "./audit.js";

const CHQ = "https://self-host-creative-system.web.app/mcp";
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

async function chq(env, name) {
  const r = await fetch(CHQ, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } }),
    headers: { Authorization: "Bearer " + env.CHQ_KEY, "content-type": "application/json", accept: "application/json, text/event-stream" } });
  const j = await r.json();
  if (j.error || j.result?.isError) throw new Error(`Creative HQ ${name}: ` + (j.error?.message || j.result.content?.[0]?.text || "failed"));
  return JSON.parse(j.result.content[0].text);
}

// Everyone who holds one of the roles: active members, plus invites not yet accepted (they're hired, just not signed in).
async function roster(env) {
  const roles = (await env.KB.get("mirror_roles", "json")) || ["strategist"];
  const [members, invites] = await Promise.all([chq(env, "list_members"), chq(env, "list_invites")]);
  const people = new Map();
  for (const m of members) if (m.active && roles.includes(m.role)) people.set(m.email.toLowerCase(), { name: m.name, email: m.email.toLowerCase(), role: m.role });
  for (const i of invites) {
    const e = i.email.toLowerCase();
    if (i.status === "pending" && roles.includes(i.role) && /^[^@\s:]+@[^@\s]+\.[a-z]+$/.test(e) && !e.endsWith("@example.com") && !people.has(e))
      people.set(e, { name: i.workspace || e, email: e, role: i.role });
  }
  return [...people.values()];
}

async function slackId(env, email, ids) {
  if (ids[email]) return ids[email];
  try {
    const { user } = await slack(env, "users.lookupByEmail", { email }, true);
    ids[email] = user.id; await env.KB.put("slack_ids", JSON.stringify(ids));
    return user.id;
  } catch { return null; }   // not in Slack yet, or the bot lacks users:read.email
}

const first = (name) => name.split(/\s+/)[0].replace(/^./, (c) => c.toUpperCase());
const inviteText = (name, link) =>
  `:bar_chart: *Your Ads Mirror access*\nHi ${first(name)}! You now have your own link to the Ads Mirror: every Auvra ad with Ads Manager's live numbers ` +
  `(spend, CTR, hook rate, CPA, ROAS), read-only and updated every 2 minutes.\n<${link}|Open the Ads Mirror>\nThis link is just for you, please don't share it.\n\n` +
  `:flag-br: *Seu acesso ao Ads Mirror*\nOi ${first(name)}! Agora você tem seu próprio link para o Ads Mirror: todos os anúncios da Auvra com os números ao vivo ` +
  `do Gerenciador de Anúncios (gasto, CTR, hook rate, CPA, ROAS), só para visualizar e atualizado a cada 2 minutos.\n<${link}|Abrir o Ads Mirror>\n` +
  `Este link é só seu, por favor não compartilhe.`;

export async function syncAccess(env) {
  if (!env.CHQ_KEY) return;
  const people = await roster(env);
  if (!people.length) return;   // a bad read must never revoke everyone
  const on = (await env.KB.get("mirror_auto")) === "on";
  const links = (await env.KB.get("mirror_links", "json")) || {};
  const blocked = new Set((await env.KB.get("mirror_blocked", "json")) || []);
  const ids = (await env.KB.get("slack_ids", "json")) || {};
  const want = new Map(people.filter((p) => !blocked.has(p.email)).map((p) => [p.email, p]));
  const have = new Map(Object.entries(links).filter(([, l]) => l.auto).map(([t, l]) => [l.email, t]));

  // Slack accounts that were deactivated lose access too, and never get a new link.
  const gone = async (id) => { try { return (await slack(env, "users.info", { user: id }, true)).user.deleted; } catch { return false; } };
  const deactivated = new Set();
  for (const [e, t] of have) if (await gone(links[t].slack)) deactivated.add(e);
  const remove = [...have].filter(([e]) => !want.has(e) || deactivated.has(e));
  const add = [...want.values()].filter((p) => !have.has(p.email));
  const plan = { at: new Date().toISOString(), on, roles: [...new Set(people.map((p) => p.role))], add: [], remove: remove.map(([, t]) => links[t].name), noSlack: [] };
  for (const p of add) {
    const id = await slackId(env, p.email, ids);
    if (!id) plan.noSlack.push(p.name);
    else if (id !== env.OWNER && !(await gone(id))) plan.add.push({ ...p, slack: id });
  }
  await env.KB.put("mirror_auto_plan", JSON.stringify(plan));
  if (!on) return plan;

  if (remove.length > Math.max(3, have.size / 2)) {   // a sudden mass removal is more likely a Creative HQ problem than real
    await audit(env, { kind: "mirror_revoke", actor_name: "Auto access", text: `held back removing ${remove.length} people's Ads mirror access`, flag: "auto access wanted to remove most strategists" });
    return plan;
  }
  for (const [e, t] of remove) {
    const l = links[t]; delete links[t];
    await env.KB.put("mirror_links", JSON.stringify(links));
    await audit(env, { kind: "mirror_revoke", actor_name: "Auto access", text: `removed ${l.name}'s Ads mirror access (${deactivated.has(e) ? "Slack account deactivated" : "no longer a " + l.role + " in Creative HQ"})` });
  }
  for (const p of plan.add) {
    const t = newToken();
    await slack(env, "chat.postMessage", { channel: p.slack, text: inviteText(p.name, MIRROR + t), unfurl_links: false });   // only saved once the DM went out
    links[t] = { name: p.name, invited: new Date().toISOString(), by: "Auto", auto: true, email: p.email, slack: p.slack, role: p.role };
    await env.KB.put("mirror_links", JSON.stringify(links));
    await audit(env, { kind: "mirror_invite", actor_name: "Auto access", text: `sent ${p.name} (${p.role}) their Ads mirror link by Slack DM` });
  }
  plan.sent = plan.add.map((p) => p.name); plan.add = [];
  await env.KB.put("mirror_auto_plan", JSON.stringify(plan));
  return plan;
}
