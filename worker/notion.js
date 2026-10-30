// Keeps a copy of the "100x Ecom SOPs" Notion pages in KV for the help bot.
// The "100x Help Bot" Notion connection (read-only) is shared with that page only, so search returns just its tree.
// Free Workers allow ~50 outbound requests per run, so each run refetches only pages edited since last time, within a budget.

const NOTION = "https://api.notion.com/v1";
const BUDGET = 40;   // Notion requests per run

export async function syncNotion(env) {
  let calls = 0;
  const notion = async (path, body) => {
    calls++;
    const r = await fetch(NOTION + path, {
      method: body ? "POST" : "GET",
      body: body ? JSON.stringify(body) : undefined,
      headers: { Authorization: "Bearer " + env.NOTION_TOKEN, "Notion-Version": "2022-06-28", "Content-Type": "application/json" },
    });
    if (!r.ok) throw new Error(`notion ${path}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    return r.json();
  };

  const pages = [];
  let cursor;
  do {
    const r = await notion("/search", { page_size: 100, filter: { property: "object", value: "page" }, ...(cursor ? { start_cursor: cursor } : {}) });
    pages.push(...r.results);
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);

  const meta = (await env.KB.get("meta", "json")) || {};
  let changed = false, pending = 0;
  for (const p of pages) {
    if (meta[p.id] === p.last_edited_time) continue;
    if (calls >= BUDGET) { pending++; continue; }
    const lines = [], slack = [];
    try { await blocks(notion, p.id, 0, lines, () => calls < BUDGET + 8, slack); }
    catch (e) { console.log("page failed", p.id, String(e)); pending++; continue; }
    await env.KB.put("page:" + p.id, JSON.stringify({ title: pageTitle(p), text: redact(lines.join("\n")) }));
    // A page titled "... (/some-command)" is what that Slack slash command posts, as-is (Slack formatting, not redacted:
    // whatever Rayston writes on those pages is what people get). The intro line above the first heading is skipped.
    const cmd = (pageTitle(p).match(/\(\/([a-z0-9-]+)\)/) || [])[1];
    if (cmd) await env.KB.put("cmd:" + cmd, slack.slice(Math.max(0, slack.findIndex(l => l.startsWith("*")))).join("\n"));
    meta[p.id] = p.last_edited_time;
    changed = true;
  }
  const live = new Set(pages.map(p => p.id));
  for (const id of Object.keys(meta)) if (!live.has(id)) { delete meta[id]; await env.KB.delete("page:" + id); changed = true; }

  if (changed) {
    await env.KB.put("meta", JSON.stringify(meta));
    const seen = new Set(), parts = [];
    for (const id of Object.keys(meta)) {
      const pg = await env.KB.get("page:" + id, "json");
      if (!pg || !pg.text.trim() || seen.has(pg.text)) continue;   // the tree has a few duplicated pages
      seen.add(pg.text);
      parts.push(`### ${pg.title}\n${pg.text.trim()}`);
    }
    await env.KB.put("corpus", parts.join("\n\n"));
  }
  console.log("notion sync", { pages: pages.length, calls, changed, pending });
}

async function blocks(notion, id, depth, out, more, slack) {
  let cursor;
  do {
    if (!more()) throw new Error("out of request budget");
    const r = await notion(`/blocks/${id}/children?page_size=100` + (cursor ? `&start_cursor=${cursor}` : ""));
    for (const b of r.results) {
      const line = blockText(b);
      if (line.trim()) out.push("  ".repeat(depth) + line);
      const s = slackText(b);
      if (s.trim()) slack.push("  ".repeat(depth) + s);
      if (b.has_children && b.type !== "child_page" && b.type !== "child_database") await blocks(notion, b.id, depth + 1, out, more, slack);
    }
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
}

function blockText(b) {
  const d = b[b.type] || {};
  const rt = a => (a || []).map(t => t.plain_text || "").join("");
  switch (b.type) {
    case "heading_1": case "heading_2": case "heading_3": return "## " + rt(d.rich_text);
    case "bulleted_list_item": case "toggle": return "• " + rt(d.rich_text);
    case "numbered_list_item": return "- " + rt(d.rich_text);
    case "to_do": return (d.checked ? "[x] " : "[ ] ") + rt(d.rich_text);
    case "table_row": return (d.cells || []).map(rt).join(" | ");
    case "child_page": return "(sub-page: " + d.title + ")";
    case "bookmark": case "embed": case "link_preview": return d.url || "";
    case "video": case "file": case "image": case "pdf": return [d.external?.url || d.name || "", rt(d.caption)].filter(Boolean).join(" ");
    default: return rt(d.rich_text);
  }
}

// Same block, as Slack mrkdwn (bold/code/links kept), for the onboarding commands.
function slackText(b) {
  const d = b[b.type] || {};
  const rt = a => (a || []).map(t => {
    let s = t.plain_text || "";
    if (!s.trim()) return s;
    if (t.annotations?.code) s = "`" + s + "`";
    else if (t.annotations?.bold) s = "*" + s.trim() + "*" + (s.endsWith(" ") ? " " : "");
    return t.href && !s.includes(t.href) ? `<${t.href}|${s}>` : s;
  }).join("");
  switch (b.type) {
    case "heading_1": case "heading_2": case "heading_3": return "*" + d.rich_text.map(t => t.plain_text).join("") + "*";
    case "bulleted_list_item": return "• " + rt(d.rich_text);
    case "numbered_list_item": return "- " + rt(d.rich_text);
    case "code": return "`" + d.rich_text.map(t => t.plain_text).join("") + "`";
    case "divider": return "";
    default: return blockText(b) && rt(d.rich_text);
  }
}

function pageTitle(p) {
  for (const v of Object.values(p.properties || {})) if (v.type === "title") return v.title.map(t => t.plain_text).join("");
  return "Untitled";
}

// Hide anything that looks like a password before the bot ever sees it.
export function redact(text) {
  return text
    .replace(/\b(passwords?|pass|pwd?|senha|token|api[ _-]?key|secret)(\s*[:=]\s*|\s+[-–]\s+)(\S+)/gi, "$1$2[hidden - ask Rayston]")
    .split(/(\s+)/)
    .map(w => (w.length >= 8 && !/^[A-Z0-9#/]+(_[A-Z0-9#/]+){2,}[.,;:]?$/.test(w) && !/^https?:\/\//.test(w)
      && !/^[a-z0-9._+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}[.,;:]?$/.test(w)
      && /[a-z]/.test(w) && /[A-Z]/.test(w) && /\d/.test(w) && /[^A-Za-z0-9]/.test(w)) ? "[hidden - ask Rayston]" : w)
    .join("");
}
