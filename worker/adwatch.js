// Rejected-ad watchdog. The appeal runner (a Claude scheduled task on Rayston's Mac, which holds the Meta token)
// reads the ad account's DISAPPROVED ads every hour and reports them here (POST /adcheck); it then clicks Meta's own
// "Request review" in Business Support Home - there is no appeal API - and reports what it appealed (POST /appealed).
// Each ad is appealed once; one still rejected after its review is never re-submitted.
// The cron here watches the watcher: a queued ad with no appeal after 3 hours, or no report from the runner in
// 3 hours, is DM'd to OWNER. State in KV "rejected": {baseline, lastReport, quietAlerted, ads: {id: {...}}}.
import { audit } from "./audit.js";

const OVERDUE_MS = 3 * 3600e3;
const load = async (env) => (await env.KB.get("rejected", "json")) || { baseline: false, ads: {} };

export async function adWatch(env, slack) {
  const st = await load(env), now = Date.now();
  let changed = false;
  if (st.lastReport && now - st.lastReport > OVERDUE_MS && !st.quietAlerted) {
    st.quietAlerted = now; changed = true;
    await audit(env, { kind: "appeal_overdue", actor_name: "Watchdog", text: "No rejected-ads check from the appeal runner since " + new Date(st.lastReport).toISOString(),
      flag: "auto-appeal runner stopped checking in" });
    await slack(env, "chat.postMessage", { channel: env.OWNER, text: ":rotating_light: *The auto-appeal runner hasn't checked Meta for rejected ads in over 3 hours.* " +
      "It runs in the Claude app on your Mac (Scheduled → \"Auto-appeal rejected Meta ads\"): is the app open?" });
  }
  const overdue = Object.entries(st.ads).filter(([, a]) => !a.appealed && !a.alerted && now - a.seen > OVERDUE_MS);
  if (overdue.length) {
    for (const [, a] of overdue) a.alerted = now;
    changed = true;
    await audit(env, { kind: "appeal_overdue", actor_name: "Watchdog", text: overdue.map(([id, a]) => `${a.name} (${id})`).join("\n"),
      flag: "rejected ads not appealed after 3 hours" });
    await slack(env, "chat.postMessage", { channel: env.OWNER, text: `:rotating_light: *${overdue.length} rejected ad(s) haven't been appealed after 3 hours:*\n` +
      overdue.map(([id, a]) => `• ${a.name} (${id}) · ${a.campaign}`).join("\n") });
  }
  if (changed) await env.KB.put("rejected", JSON.stringify(st));
}

// POST /adcheck  {rejected: [{id, name, campaign}]}  -> the runner's view of Meta; returns the ads waiting for an appeal.
// POST /appealed {ids: [...], ok, note}               -> what the runner appealed (or failed to).
export async function appealApi(req, env, path) {
  const st = await load(env), now = Date.now(), body = await req.json();
  if (path === "/adcheck") {
    const live = new Set();
    for (const a of body.rejected || []) {
      live.add(a.id);
      if (st.ads[a.id]) continue;
      // The first report only records what was already rejected before the watchdog existed.
      st.ads[a.id] = { name: a.name, campaign: a.campaign || "", seen: now, appealed: st.baseline ? null : "before watchdog" };
      if (st.baseline) await audit(env, { kind: "ad_rejected", actor_name: "Meta", channel_name: a.campaign, text: `${a.name} (${a.id})`,
        flag: "ad rejected by Meta - auto-appeal queued" });
    }
    for (const [id, a] of Object.entries(st.ads)) {
      if (live.has(id)) continue;
      if (a.appealed && a.appealed !== "before watchdog")
        await audit(env, { kind: "ad_restored", actor_name: "Meta", channel_name: a.campaign, text: `${a.name} (${id}) is no longer rejected` });
      delete st.ads[id];
    }
    if (st.quietAlerted) await audit(env, { kind: "appeal", actor_name: "Auto-appeal runner", text: "Runner checking in again" });
    Object.assign(st, { baseline: true, lastReport: now, quietAlerted: null });
    await env.KB.put("rejected", JSON.stringify(st));
    return Response.json(Object.entries(st.ads).filter(([, a]) => !a.appealed).map(([id, a]) => ({ id, ...a })));
  }
  const { ids = [], ok = false, note = "" } = body;
  if (ok) for (const id of ids) if (st.ads[id]) st.ads[id].appealed = now;
  await env.KB.put("rejected", JSON.stringify(st));
  await audit(env, { kind: "appeal", actor_name: "Auto-appeal runner",
    text: (ok ? "Appealed:\n" : "Appeal FAILED:\n") + ids.map((id) => `${st.ads[id]?.name || "?"} (${id})`).join("\n") + (note ? `\n${note}` : ""),
    flag: ok ? "" : "auto-appeal failed" });
  return Response.json({ recorded: ids.length, ok });
}
