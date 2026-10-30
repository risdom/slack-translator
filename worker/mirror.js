// "Ads Manager mirror": a read-only copy of Ads Manager for the creative team - all of the account's ads with its date
// presets, filters and columns, plus a Strategist filter (naming prefixes in KV "mirror_cs"). Invite-only: OWNER invites
// people from the admin page (/ads-admin/<admin token>), each gets a personal link (/ads/<token>), and revoking deletes
// the token so the link stops working at once. Live: the page asks Meta when opened and every 2 minutes; answers are
// cached 2 minutes per date range (shared by everyone) so the account's Meta rate limit is never at risk.
// KV "mirror_links": {token: {name, invited, by}}; KV "mirror_admin": admin token. Secrets META_TOKEN, META_ACCOUNT.
// Invites, revokes and every page open go to the audit log.
import { audit } from "./audit.js";
import { PAGE, ADMIN_PAGE } from "./mirror_page.js";

const GRAPH = "https://graph.facebook.com/v23.0/";
const PRESETS = new Set(["today", "yesterday", "last_3d", "last_7d", "last_14d", "last_30d", "this_month", "last_month", "maximum"]);
const INSIGHT_FIELDS = "ad_id,ad_name,adset_name,campaign_name,spend,impressions,reach,frequency,inline_link_clicks,actions,action_values,video_thruplay_watched_actions";

async function graph(env, path, params) {
  const r = await (await fetch(GRAPH + path + "?" + new URLSearchParams({ ...params, access_token: env.META_TOKEN }))).json();
  if (r.error) throw new Error(r.error.message);
  return r;
}
async function pages(env, path, params, max = 6) {
  let out = [], r = await graph(env, path, params);
  for (let i = 0; ; i++) {
    out = out.concat(r.data || []);
    if (!r.paging?.next || i >= max) break;
    r = await (await fetch(r.paging.next)).json();
    if (r.error) throw new Error(r.error.message);
  }
  return out;
}

const act = (row, ...types) => { for (const t of types) { const a = (row || []).find((x) => x.action_type === t); if (a) return Number(a.value); } return 0; };

function owns(rule, adName, adsetName) {
  if (!rule) return true;   // owner: everything
  const up = (s) => (s || "").toUpperCase();
  return (rule.ad || []).some((p) => up(adName).startsWith(up(p))) || (rule.adset || []).some((p) => up(adsetName).startsWith(up(p)));
}

// The Ads Manager metrics this page shows, from one insights row (an ad, or an ad in one breakdown slice).
function metrics(r) {
  return {
    spend: Number(r.spend || 0), impressions: Number(r.impressions || 0), reach: Number(r.reach || 0),
    link_clicks: Number(r.inline_link_clicks || 0),
    purchases: act(r.actions, "omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase"),
    revenue: act(r.action_values, "omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase"),
    atc: act(r.actions, "omni_add_to_cart", "add_to_cart", "offsite_conversion.fb_pixel_add_to_cart"),
    checkouts: act(r.actions, "omni_initiated_checkout", "initiate_checkout", "offsite_conversion.fb_pixel_initiate_checkout"),
    lpv: act(r.actions, "landing_page_view", "omni_landing_page_view"),
    video3s: act(r.actions, "video_view"),
    thruplay: act(r.video_thruplay_watched_actions, "video_view"),
  };
}

// Budgets shown read-only beside campaign and ad set names (CBO budget, ad set minimum/daily budget).
async function budgets(env) {
  const live = JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE", "PAUSED", "IN_PROCESS", "WITH_ISSUES"] }]);
  const camps = await pages(env, `${env.META_ACCOUNT}/campaigns`, { fields: "name,daily_budget,lifetime_budget,effective_status", limit: "200", filtering: live }, 2);
  const sets = await pages(env, `${env.META_ACCOUNT}/adsets`, { fields: "name,daily_budget,daily_min_spend_target,daily_spend_cap,effective_status", limit: "500", filtering: live }, 2);
  const money = (v) => (v ? Number(v) / 100 : null);
  return {
    campaigns: Object.fromEntries(camps.map((c) => [c.name, { daily: money(c.daily_budget), lifetime: money(c.lifetime_budget), status: c.effective_status }])),
    adsets: Object.fromEntries(sets.map((a) => [a.name, { daily: money(a.daily_budget), min: money(a.daily_min_spend_target), cap: money(a.daily_spend_cap), status: a.effective_status }])),
  };
}

// A breakdown (age, gender, platform, placement, device) for every ad, as small rows keyed by ad id.
const BREAKDOWNS = { age: "age", gender: "gender", platform: "publisher_platform", placement: "publisher_platform,platform_position", device: "impression_device" };
async function breakdown(env, by, range) {
  const time = range.preset ? { date_preset: range.preset } : { time_range: JSON.stringify({ since: range.since, until: range.until }) };
  const rows = await pages(env, `${env.META_ACCOUNT}/insights`, { level: "ad", breakdowns: BREAKDOWNS[by], limit: "500", ...time,
    fields: "ad_id,spend,impressions,reach,inline_link_clicks,actions,action_values,video_thruplay_watched_actions" }, 8);
  return rows.map((r) => ({ ad: r.ad_id, key: BREAKDOWNS[by].split(",").map((f) => r[f]).filter(Boolean).join(" · ") || "Unknown", ...metrics(r) }));
}

async function load(env, rule, range) {
  const time = range.preset ? { date_preset: range.preset } : { time_range: JSON.stringify({ since: range.since, until: range.until }) };
  const filters = rule ? [...(rule.ad || []).map((p) => ["ad.name", p]), ...(rule.adset || []).map((p) => ["adset.name", p])] : [[null]];
  const ins = [], ads = [];
  for (const [field, p] of filters) {   // Meta's name filter is "contains": narrow at Meta, then match the prefix exactly here
    const f = field ? { filtering: JSON.stringify([{ field, operator: "CONTAIN", value: p }]) } : {};
    ins.push(...await pages(env, `${env.META_ACCOUNT}/insights`, { level: "ad", fields: INSIGHT_FIELDS, limit: "500", ...time, ...f }));
    const af = field ? [{ field: field === "ad.name" ? "name" : "adset.name", operator: "CONTAIN", value: p }] : [];
    // Ads that are on or waiting on Meta; anything else that delivered in the range comes from insights (shown as Off).
    af.push({ field: "effective_status", operator: "IN", value: ["ACTIVE", "IN_PROCESS", "PENDING_REVIEW", "WITH_ISSUES", "DISAPPROVED", "PREAPPROVED"] });
    ads.push(...await pages(env, `${env.META_ACCOUNT}/ads`, { fields: "id,name,effective_status,created_time,adset{name},campaign{name},creative{thumbnail_url},preview_shareable_link",
      limit: "500", filtering: JSON.stringify(af) }, 3));
  }
  const byId = new Map();
  for (const a of ads) if (owns(rule, a.name, a.adset?.name))
    byId.set(a.id, { id: a.id, name: a.name, adset: a.adset?.name || "", campaign: a.campaign?.name || "", status: a.effective_status,
      created: a.created_time, thumb: a.creative?.thumbnail_url || "", preview: a.preview_shareable_link || "" });
  for (const r of ins) {
    if (!owns(rule, r.ad_name, r.adset_name)) continue;
    const row = byId.get(r.ad_id) || { id: r.ad_id, name: r.ad_name, adset: r.adset_name, campaign: r.campaign_name, status: "OFF", thumb: "", preview: "" };
    Object.assign(row, metrics(r));
    byId.set(r.ad_id, row);
  }
  return [...byId.values()];
}

const json = (o, status = 200) => Response.json(o, { status, headers: { "cache-control": "no-store" } });
const newToken = () => [...crypto.getRandomValues(new Uint8Array(18))].map((b) => b.toString(16).padStart(2, "0")).join("");

// /ads/<token>[/data] - the mirror itself, for invited people.
export async function mirror(req, env, ctx) {
  const url = new URL(req.url), [, , token, sub] = url.pathname.split("/");
  const links = (await env.KB.get("mirror_links", "json")) || {};
  const who = links[token];
  if (!who) {
    ctx.waitUntil(audit(env, { kind: "bad_signature", text: "Ads mirror link that isn't (or is no longer) valid, from " + (req.headers.get("cf-connecting-ip") || "?"),
      flag: "someone used an invalid or revoked Ads mirror link" }));
    return new Response("This link isn't valid or your access was removed. Ask Rayston for access.", { status: 404 });
  }
  if (sub !== "data") {
    ctx.waitUntil(audit(env, { kind: "mirror_view", actor_name: who.name, text: "opened the Ads mirror" }));
    return new Response(PAGE.replace("__WHO__", who.name.replace(/[<>&"]/g, "")), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }
  const preset = url.searchParams.get("preset"), since = url.searchParams.get("since"), until = url.searchParams.get("until");
  const range = PRESETS.has(preset) ? { preset } : (/^\d{4}-\d{2}-\d{2}$/.test(since || "") && /^\d{4}-\d{2}-\d{2}$/.test(until || "")) ? { since, until } : { preset: "last_7d" };
  const by = BREAKDOWNS[url.searchParams.get("breakdown")] ? url.searchParams.get("breakdown") : null;
  const key = new Request(`https://mirror.cache/all/${range.preset || range.since + "_" + range.until}/${by || "main"}`);
  const hit = await caches.default.match(key);
  if (hit) return hit;
  try {
    const body = by ? { range, by, fetched: new Date().toISOString(), rows: await breakdown(env, by, range) }
      : { range, fetched: new Date().toISOString(), strategists: (await env.KB.get("mirror_cs", "json")) || {}, budgets: await budgets(env), rows: await load(env, null, range) };
    const res = Response.json(body,
      { headers: { "cache-control": "max-age=120" } });
    ctx.waitUntil(caches.default.put(key, res.clone()));
    return res;
  } catch (e) {
    return json({ error: "Meta didn't answer: " + String(e.message || e).slice(0, 200) + ". Try again in a minute." }, 502);
  }
}

// /ads-admin/<admin token>[/invite|/revoke] - OWNER's page to invite people and remove access.
export async function mirrorAdmin(req, env, ctx) {
  const url = new URL(req.url), [, , token, action] = url.pathname.split("/");
  const admin = await env.KB.get("mirror_admin");
  if (!admin || token !== admin) {
    ctx.waitUntil(audit(env, { kind: "bad_signature", text: "wrong Ads mirror admin link from " + (req.headers.get("cf-connecting-ip") || "?"), flag: "someone tried the Ads mirror admin page" }));
    return new Response("Not found", { status: 404 });
  }
  const links = (await env.KB.get("mirror_links", "json")) || {};
  const base = `${url.origin}/ads/`;
  if (req.method === "GET" && !action)
    return new Response(ADMIN_PAGE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  if (req.method === "GET" && action === "list")
    return json(Object.entries(links).map(([t, l]) => ({ token: t, link: base + t, ...l })).sort((a, b) => b.invited.localeCompare(a.invited)));
  if (req.method === "POST" && action === "invite") {
    const { name } = await req.json();
    const clean = String(name || "").trim().slice(0, 80);
    if (!clean) return json({ error: "Type the person's name." }, 400);
    const t = newToken();
    links[t] = { name: clean, invited: new Date().toISOString(), by: "Rayston" };
    await env.KB.put("mirror_links", JSON.stringify(links));
    await audit(env, { kind: "mirror_invite", actor_name: "Rayston", text: `invited ${clean} to the Ads mirror` });
    return json({ name: clean, link: base + t });
  }
  if (req.method === "POST" && action === "revoke") {
    const { token: t } = await req.json();
    const gone = links[t];
    if (!gone) return json({ error: "Already removed." }, 404);
    delete links[t];
    await env.KB.put("mirror_links", JSON.stringify(links));
    await audit(env, { kind: "mirror_revoke", actor_name: "Rayston", text: `removed ${gone.name}'s access to the Ads mirror` });
    return json({ removed: gone.name });
  }
  return json({ error: "Unknown action" }, 400);
}
