// Pre-launch audit: every batch that lands in Creative HQ's launch queue is checked before OWNER is pinged, so mistakes are
// fixed by the strategist before launch instead of found at launch. Checks: Meta copy in the brief (or its doc), naming
// convention, media reachable (Drive shared), duplicate hook uploads, all hooks in, format vs media (static = image).
// Problems go straight to that strategist's CS chat (EN + PT) with links to where they're fixed; KV "cs_channels"
// {workspace: channel id} routes them. Used by queue.js.

const TYPES = {
  missing_copy: ["Meta copy missing from the brief", "Texto do anúncio faltando no brief",
    "The brief doesn't include the Meta fields listed below, so the ad can't be launched.",
    "O brief não traz os campos do Meta listados abaixo, então o anúncio não pode ser lançado.",
    "Add them to the brief's details (Primary text, Headlines 1-5, Description, Link, CTA button), then reply here.",
    "Adicionem esses campos nos detalhes do brief (Primary text, Headlines 1-5, Description, Link, CTA button) e respondam aqui."],
  naming: ["Naming convention not followed", "Convenção de nomes não seguida",
    "The name below doesn't follow the convention, so the ad can't be tracked back to the CS, batch, hook and editor.",
    "O nome abaixo não segue a convenção, então não dá para rastrear o anúncio até o CS, batch, hook e editor.",
    "Rename the brief to CS_BATCH#H#_ANGLE_PERSONA/AVATAR_FORMAT_EDITOR_DATE (H1/H2/H3 right after the batch number).",
    "Renomeiem o brief para CS_BATCH#H#_ANGLE_PERSONA/AVATAR_FORMAT_EDITOR_DATE (H1/H2/H3 logo depois do número do batch)."],
  drive_access: ["Can't open the Drive file/folder", "Não foi possível abrir o arquivo/pasta do Drive",
    "The link below isn't shared, so nobody else can open it and the ad can't be built from it.",
    "O link abaixo não está compartilhado, então ninguém mais consegue abrir e o anúncio não pode ser montado.",
    "In Drive: Share → General access → \"Anyone with the link\" (Viewer), then reply here.",
    "No Drive: Compartilhar → Acesso geral → \"Qualquer pessoa com o link\" (Leitor), e respondam aqui."],
  duplicate_video: ["Same file uploaded for different hooks", "Mesmo arquivo enviado para hooks diferentes",
    "The hooks below are the exact same file, so only one of them could go live.",
    "Os hooks abaixo são exatamente o mesmo arquivo, então só um deles poderia ir ao ar.",
    "Upload the right cut for each hook as a new version in the brief.",
    "Enviem o corte certo de cada hook como uma nova versão no brief."],
  missing_hooks: ["Hooks missing", "Hooks faltando",
    "This batch has fewer than 3 hooks ready, so it would launch with fewer hooks than planned.",
    "Este batch tem menos de 3 hooks prontos, então iria ao ar com menos hooks do que o planejado.",
    "Submit and approve the missing hooks (H1, H2, H3) so the whole batch launches together.",
    "Enviem e aprovem os hooks que faltam (H1, H2, H3) para o batch inteiro ir ao ar junto."],
  wrong_format: ["Media doesn't match the format", "Mídia não bate com o formato",
    "The brief's format and the approved file don't match (a static brief needs an image, a video brief needs a video).",
    "O formato do brief e o arquivo aprovado não batem (brief estático precisa de imagem, brief de vídeo precisa de vídeo).",
    "Approve the right file for the format, or fix the format in the brief name/details.",
    "Aprovem o arquivo certo para o formato, ou corrijam o formato no nome/detalhes do brief."],
};
const WHY = "*Why it matters:* this bottlenecks launching ads and slows the feedback loop for both the creative strategist and the video editor. " +
  "*Please don't let this happen again.* Reply here once it's fixed.";
const WHY_PT = "_Por que isso importa: isso trava o lançamento dos anúncios e atrasa o ciclo de feedback tanto do creative strategist quanto do editor de vídeo. " +
  "Por favor, não deixem isso acontecer de novo. Respondam aqui quando estiver corrigido._";

export function report(issues) {
  const out = [":clipboard: *Pre-launch check: fix before this can launch* / _Checagem antes do lançamento: corrijam antes de lançar_"];
  issues.forEach((i, n) => {
    const [tEn, tPt, wEn, wPt, fEn, fPt] = TYPES[i.type];
    out.push(`\n*${n + 1}. ${tEn}* / _${tPt}_`, `• *Issue:* ${wEn}\n  _${wPt}_`);
    if (i.missing?.length) out.push(`• *Missing:* ${i.missing.join(", ")}`);
    if (i.detail) out.push(`• *Details:* ${i.detail}`);
    for (const x of i.items || []) out.push(`• *Affected:* \`${x}\``);
    out.push(`• *Fix now:* ${fEn}\n  _${fPt}_`);
    if (i.links?.length) out.push("• *Fix it here / Corrija aqui:* " + i.links.map(([t, u]) => `<${u}|${t}>`).join(" · "));
  });
  out.push("\n" + WHY + "\n" + WHY_PT);
  return out.join("\n");
}

// --- helpers
const DOC = /https:\/\/docs\.google\.com\/document\/d\/([\w-]+)/;
const driveFile = (u) => (u.match(/drive\.google\.com\/file\/d\/([\w-]+)/) || [])[1];
const driveFolder = (u) => (u.match(/drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/([\w-]+)/) || [])[1];

async function docText(url) {
  const id = (url.match(DOC) || [])[1];
  if (!id) return null;
  const r = await fetch(`https://docs.google.com/document/d/${id}/export?format=txt`, { redirect: "follow" });
  const t = r.ok ? await r.text() : "";
  return r.ok && !/<html/i.test(t.slice(0, 200)) ? t : false;   // false = not shared
}

// Which Meta fields are present, looking at the brief's details and, if it links one, its doc.
function metaFields(text) {
  const has = (re) => re.test(text);
  return {
    "Primary text": has(/\n\s*(Primary text|Texto principal)\s*:?\s*\n\s*\S/i),
    "Headlines": has(/\n\s*(Headlines?|T[ií]tulos?)\s*:?\s*\n\s*\S/i),
    "Link": has(/https:\/\/(www\.)?tryauvra\.com/i),
    "CTA button": has(/\n\s*CTA( button)?\s*:?\s*\n?\s*(Shop now|Learn more|Order now|Buy now|Sign up|Get offer)/i),
  };
}

// First 64 KB + total size of a file: enough to tell what it is and to spot two hooks that are the same upload.
async function probe(url) {
  const f = driveFile(url);
  const src = f ? `https://drive.usercontent.google.com/download?id=${f}&export=download&confirm=t` : url;
  try {
    const r = await fetch(src, { headers: { Range: "bytes=0-65535" }, redirect: "follow" });
    const type = r.headers.get("content-type") || "";
    if (!r.ok || type.startsWith("text/html")) return { ok: false };
    const buf = await r.arrayBuffer();
    const size = (r.headers.get("content-range") || "").split("/")[1] || r.headers.get("content-length") || "";
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", buf))].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
    return { ok: true, kind: type.startsWith("image/") ? "image" : type.startsWith("video/") || type.includes("octet-stream") ? "video" : type, sig: hash + ":" + size };
  } catch { return { ok: false }; }
}

async function folderFiles(id) {
  const r = await fetch(`https://drive.google.com/embeddedfolderview?id=${id}`);
  if (!r.ok) return null;
  const html = await r.text();
  return [...html.matchAll(/href="https:\/\/drive\.google\.com\/file\/d\/([\w-]+)[^"]*".*?flip-entry-title">([^<]*)/gs)].map((m) => ({ id: m[1], name: m[2] }));
}

const NAME = /^[A-Z]{2,}_(BATCH\d+|B\d+)(H\d+(-H\d+)*)?_[^_]+_[^_]+_[^_]+_[^_]+_\d/;

// Audits one batch (all its ready briefs). Returns the list of issues (empty = clean).
export async function auditBatch(briefs, siblings) {
  const issues = [], b0 = briefs[0];
  const links = (b) => [["Open the brief in Creative OS", b.url], ...(b.doc ? [["Script doc", b.doc]] : []), ...(b.folder ? [["Drive folder", b.folder]] : [])];

  // Meta copy: the brief's details, plus its doc when the details point to one.
  for (const b of briefs.slice(0, 1)) {
    let text = "\n" + (b.details || "");
    const doc = (b.details || "").match(DOC)?.[0];
    if (doc) { b.doc = doc; const t = await docText(doc); if (t === false) issues.push({ type: "drive_access", items: [b.title], detail: "The script doc isn't shared.", links: [["Script doc", doc]] }); else if (t) text += "\n" + t; }
    const missing = Object.entries(metaFields(text)).filter(([, ok]) => !ok).map(([k]) => k);
    if (missing.length) issues.push({ type: "missing_copy", items: briefs.map((x) => x.title), missing, links: links(b) });
  }

  // Naming
  // Placeholders left in ("CS_" instead of the strategist's initials, "TBD" instead of the editor) count as wrong too.
  const badNames = briefs.filter((b) => !NAME.test(b.title) || /^CS_/.test(b.title) || /_TBD_/.test(b.title)).map((b) => b.title);
  if (badNames.length) issues.push({ type: "naming", items: badNames, links: links(b0) });

  // Media: reachable, which kind, duplicates, hook count
  const files = [];   // {hook, url, title}
  for (const b of briefs) {
    const folder = driveFolder(b.approvedVideoUrl || "");
    if (folder) {
      b.folder = b.approvedVideoUrl;
      const list = await folderFiles(folder);
      if (!list || !list.length) { issues.push({ type: "drive_access", items: [b.title], detail: "The Drive folder is empty or not shared.", links: [["Drive folder", b.approvedVideoUrl]] }); continue; }
      list.forEach((f, i) => files.push({ hook: (f.name.match(/H0?(\d+)/) || [, i + 1])[1], url: `https://drive.google.com/file/d/${f.id}/view`, title: f.name, brief: b }));
    } else files.push({ hook: (b.title.match(/(?:BATCH\d+|B\d+)H(\d+)/) || [, "?"])[1], url: b.approvedVideoUrl, title: b.title, brief: b });
  }
  const seen = new Map(), dup = [], locked = [], wrong = [];
  const isStatic = /STATIC|IMAGE/i.test(b0.title) || /static|image/i.test(b0.format || "");
  for (const f of files) {
    const p = await probe(f.url);
    if (!p.ok) { locked.push(f); continue; }
    if (seen.has(p.sig)) dup.push(`H${seen.get(p.sig)} and H${f.hook} (${f.title})`); else seen.set(p.sig, f.hook);
    if ((isStatic && p.kind === "video") || (!isStatic && p.kind === "image")) wrong.push(`${f.title}: ${p.kind} for a ${isStatic ? "static" : "video"} brief`);
  }
  if (locked.length) issues.push({ type: "drive_access", items: locked.map((f) => f.title), links: locked.map((f) => ["Open the file", f.url]).slice(0, 3) });
  if (dup.length) issues.push({ type: "duplicate_video", items: dup, links: links(b0) });
  if (wrong.length) issues.push({ type: "wrong_format", items: wrong, links: links(b0) });
  const hooks = new Set([...files.map((f) => f.hook), ...siblings.map((s) => (s.title.match(/(?:BATCH\d+|B\d+)H(\d+)/) || [])[1]).filter(Boolean)]);
  if (hooks.size < 3) issues.push({ type: "missing_hooks", items: briefs.map((b) => b.title), detail: `Hooks ready: ${[...hooks].sort().map((h) => "H" + h).join(", ") || "none"}.`, links: links(b0) });
  return issues;
}
