// Launch-queue watcher: on the 10-minute cron, reads Creative HQ's launch queue, audits each newly ready batch (prelaunch.js)
// and tells the right people. Mistakes go straight to that strategist's CS chat with links to fix them, before launch;
// OWNER gets one DM per run listing each batch as clean (ready to launch, scheduled for the next 12 AM ET) or sent back.
// A batch is audited once its newest approval is 15 minutes old (the other hooks are usually approved right after),
// and again whenever one of its briefs changes (a fix), so OWNER hears when it turns clean. Nothing is launched here.
// Creative HQ is read with secret CHQ_KEY. KV "queue_audit": {batch: {stamp, sig, clean}}; KV "cs_channels": {workspace: channel}.
import { audit } from "./audit.js";
import { auditBatch, report } from "./prelaunch.js";

const CHQ = "https://self-host-creative-system.web.app/mcp";
const SETTLE_MS = 15 * 60 * 1000;

async function chq(env, name, args = {}) {
  const r = await fetch(CHQ, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    headers: { Authorization: "Bearer " + env.CHQ_KEY, "content-type": "application/json", accept: "application/json, text/event-stream" } });
  const j = await r.json();
  if (j.error || j.result?.isError) throw new Error(`Creative HQ ${name}: ` + (j.error?.message || j.result.content?.[0]?.text || "failed"));
  return JSON.parse(j.result.content[0].text);
}

// Same batch = same workspace + name without the hook number, the trailing date (hooks are often dated a day apart), the CS prefix
// and the editor (so a hook left with "CS_"/"TBD" placeholders still lands in its batch, where the naming check flags it).
const batchOf = (a) => a.workspace + "|" + a.title.replace(/((?:BATCH|B)\d+)H\d+(-H\d+)*(?=_)/, "$1").replace(/_[\d/.-]+$/, "").split("_").slice(1, -1).join("_");

export async function queueWatch(env, slack) {
  if (!env.CHQ_KEY) return;
  const { ads } = await chq(env, "list_launch_queue", { view: "all" });
  const ready = ads.filter((a) => a.launchStatus === "ready"), launched = ads.filter((a) => a.launchStatus !== "ready");
  const state = (await env.KB.get("queue_audit", "json")) || {};
  const channels = (await env.KB.get("cs_channels", "json")) || {};
  const batches = new Map();
  for (const a of ready) { const k = batchOf(a); if (!batches.has(k)) batches.set(k, []); batches.get(k).push(a); }

  const lines = [], now = Date.now();
  for (const [k, items] of batches) {
    const stamp = items.map((a) => a.id + ":" + a.updatedAt).sort().join(",");
    if (state[k]?.stamp === stamp) continue;   // nothing changed since the last audit
    if (now - Math.max(...items.map((a) => Date.parse(a.approvedAt || a.updatedAt))) < SETTLE_MS) continue;   // hooks may still be coming
    const briefs = [];
    for (const a of items) briefs.push({ ...a, ...(await chq(env, "get_brief", { brief_id: a.id })) });
    briefs.sort((x, y) => x.title.localeCompare(y.title));
    const issues = await auditBatch(briefs, launched.filter((a) => batchOf(a) === k));
    const sig = JSON.stringify(issues.map((i) => [i.type, i.missing, i.items]));
    const name = briefs[0].title.replace(/((?:BATCH|B)\d+)H\d+(-H\d+)*(?=_)/, "$1"), ws = items[0].workspace, link = `<${briefs[0].url}|${name}>`;
    if (issues.length) {
      if (state[k]?.sig !== sig) {   // only re-send when the problems changed
        const ch = channels[ws];
        if (ch) await slack(env, "chat.postMessage", { channel: ch, text: report(issues), unfurl_links: false });
        await audit(env, { kind: "cs_ping", actor_name: "Pre-launch check", channel_id: ch || "", text: `sent ${ws} ${issues.length} pre-launch issue(s) for ${name}: ${issues.map((i) => i.type).join(", ")}` });
        lines.push(`:warning: *${ws}*: ${link}\n      ${issues.map((i) => TYPE_LABEL[i.type] + (i.missing ? ` (${i.missing.join(", ")})` : "")).join(" · ")}${ch ? " → sent to their CS chat to fix" : " → no CS chat on file, tell them"}`);
      }
    } else lines.push(`:white_check_mark: *${ws}*: ${link} (${items.length} brief${items.length > 1 ? "s" : ""}): passed the pre-launch check, ready to launch`);
    state[k] = { stamp, sig, clean: !issues.length, at: new Date().toISOString() };
  }
  for (const k of Object.keys(state)) if (!batches.has(k)) delete state[k];   // launched or pulled from the queue
  await env.KB.put("queue_audit", JSON.stringify(state));
  if (!lines.length) return;
  const clean = lines.filter((l) => l.startsWith(":white")).length;
  await slack(env, "chat.postMessage", { channel: env.OWNER, unfurl_links: false, text:
    `:rocket: *Launch queue update*\n\n${lines.join("\n\n")}\n\n` +
    (clean ? `Tell Claude "launch the queue" and the clean batches go live at the next 12:00 AM ET.` : `Nothing to launch yet: the strategists have been sent what to fix.`) });
}

const TYPE_LABEL = { missing_copy: "Meta copy missing", naming: "naming", drive_access: "Drive not shared", duplicate_video: "duplicate hook upload",
  missing_hooks: "hooks missing", wrong_format: "format doesn't match media" };
