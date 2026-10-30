// Launch-queue watcher: on the 10-minute cron, asks Creative HQ for ads approved and ready to launch and DMs OWNER one
// summary of the new ones, grouped by batch, so they can tell Claude to launch them. Nothing is launched from here.
// Creative HQ is read with secret CHQ_KEY (stateless MCP tools/call). KV "queue_seen": ids already pinged that are still
// in the queue (an ad that leaves and comes back is pinged again).
import { audit } from "./audit.js";

const CHQ = "https://self-host-creative-system.web.app/mcp";

async function chq(env, name, args = {}) {
  const r = await fetch(CHQ, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    headers: { Authorization: "Bearer " + env.CHQ_KEY, "content-type": "application/json", accept: "application/json, text/event-stream" } });
  const j = await r.json();
  if (j.error || j.result?.isError) throw new Error(`Creative HQ ${name}: ` + (j.error?.message || j.result.content?.[0]?.text || "failed"));
  return JSON.parse(j.result.content[0].text);
}

export async function queueWatch(env, slack) {
  if (!env.CHQ_KEY) return;
  const { ads } = await chq(env, "list_launch_queue", { view: "ready" });
  const seen = new Set((await env.KB.get("queue_seen", "json")) || []);
  const fresh = ads.filter((a) => !seen.has(a.id));
  await env.KB.put("queue_seen", JSON.stringify(ads.map((a) => a.id)));
  if (!fresh.length) return;

  // One line per batch: the title without its H1/H2/H3, with how many hooks are ready.
  const batches = new Map();
  for (const a of fresh) {
    const key = a.workspace + "|" + a.title.replace(/H\d+(?=_)/, "");
    if (!batches.has(key)) batches.set(key, { ws: a.workspace, name: a.title.replace(/H\d+(?=_)/, ""), url: a.url, n: 0 });
    batches.get(key).n++;
  }
  const byWs = new Map();
  for (const b of batches.values()) { if (!byWs.has(b.ws)) byWs.set(b.ws, []); byWs.get(b.ws).push(b); }
  const lines = [...byWs].map(([ws, bs]) => `*${ws}*\n` + bs.map((b) => `• <${b.url}|${b.name}>${b.n > 1 ? ` (${b.n} hooks)` : ""}`).join("\n"));
  const text = `:rocket: *${fresh.length} new ad${fresh.length > 1 ? "s" : ""} ready to launch in Creative OS*` +
    (ads.length > fresh.length ? ` (${ads.length} waiting in total)` : "") + `\n\n${lines.join("\n\n")}\n\n` +
    `Tell Claude "launch the queue" when you want them live.`;
  await slack(env, "chat.postMessage", { channel: env.OWNER, text, unfurl_links: false });
  await audit(env, { kind: "queue_ping", actor_name: "Launch-queue watcher", text: `pinged the owner about ${fresh.length} new ads ready to launch` });
}
