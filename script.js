/**
 * ============================================================
 *  Zotero Actions & Tags Script · DeepSeek 二阶段 + 本地 PDF + 标签对齐
 *  - 本地 pdf.js 读取 PDF 正文（不上传、无 OCR）
 *  - 二阶段抽取：Stage1 摘要 → Stage2 严格 JSON
 *  - 全库结构化标签(key:value)扫描 → 按字段分组注入提示词，优先复用高频标签
 *  - Tags 写入（field:value，多条），Extra 写入 YAML（# ai_metadata，智能更新）
 *  - institution：中文保留 / 名校缩写 / 其他原样；扩展字段 ≤ 3；缺失字段跳过
 *  - 使用 {items} 注入，不调用 getSelectedItems()
 * ============================================================
 */

// ==================== ① 配置区 ====================
const DEEPSEEK_API_KEY = "DEEPSEEK_API_KEY"; // ← 必填
const MODEL = "deepseek-chat";                          // 推荐 deepseek-chat
const USE_NOTES = true;                                 // 读取子笔记
const MAX_EXTENDED_FIELDS = 3;                          // 扩展字段上限
const AI_YAML_MARK = "# ai_metadata";                   // YAML 标记
const YAML_BLOCK_HEADER = "---";                        // YAML 分隔线
const MAX_NOTES_CHARS = 8000;                           // Notes 合并长度上限

// 本地 PDF 提取（Zotero 内置 pdf.js 全文索引）
const LOCAL_PDF_ENABLED = true;                         // 开启本地 PDF 正文读取
const LOCAL_PDF_MAX_CHARS = 80000;                      // PDF 文本清洗后最大拼接长度

// —— 全库结构化标签扫描 & 提示注入 ——
// 结构化标签识别规则：key 仅小写字母和下划线，形如 key:value（不含第二个冒号）
const STRUCTURED_TAG_REGEX = /^([a-z_]+):([^:]+)$/;
// 当全库结构化标签数量非常大时（> 1500）——你的选择 F3：按字段分组提供（依然全部提供）
// 为了避免极端超长，这里设置“每个字段组的软上限”（超过则只取该组内的高频前 N）
const TAGS_TOTAL_SOFT_TRIGGER = 1500;  // 触发“超大库”策略的阈值
const TAGS_PER_KEY_SOFT_CAP   = 400;   // 超大库时每个 key 组最多提供的条目数（按频次截断）
const TAGS_INCLUDE_COUNTS     = true;  // 在提示中显示频次(帮助模型选择高频写法)

// ==================== ② 工具函数 ====================
function dedupe(arr) {
  const seen = new Set(); const out = [];
  for (const x of arr || []) if (!seen.has(x)) { seen.add(x); out.push(x); }
  return out;
}
function ensureArray(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map(s => (s ?? "").toString().trim()).filter(Boolean);
  const s = (v ?? "").toString().trim(); return s ? [s] : [];
}
function toYAML(obj) {
  const keys = Object.keys(obj || {}); const lines = [];
  for (const k of keys) {
    const v = obj[k];
    if (Array.isArray(v)) {
      const arr = v.map(x => (x ?? "").toString().replace(/\n/g, " ").replace(/:/g, "\\:").trim()).filter(Boolean);
      if (!arr.length) continue;
      lines.push(`${k}:`); for (const it of arr) lines.push(`  - ${it}`);
    } else {
      const s = (v ?? "").toString().replace(/\n/g, " ").replace(/:/g, "\\:").trim();
      if (s) lines.push(`${k}: ${s}`);
    }
  }
  return lines.join("\n");
}
function extractJsonStrict(s) {
  if (!s) return null;
  let t = s.trim();
  t = t.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  t = t.replace(/^```/, "").replace(/```$/, "");
  const first = t.indexOf("{"), last = t.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  t = t.slice(first, last + 1).trim();
  try { return JSON.parse(t); } catch (_) { return null; }
}
function delay(ms) { return new Promise(res => setTimeout(res, ms)); }

// ==================== ③ institution 规则模块 ====================
const FAMOUS_ABBREV = {
  "Massachusetts Institute of Technology": "MIT",
  "Stanford University": "Stanford",
  "Carnegie Mellon University": "CMU",
  "University of California, Berkeley": "UC Berkeley",
  "University of California Berkeley": "UC Berkeley",
  "California Institute of Technology": "Caltech",
  "University of Illinois Urbana-Champaign": "UIUC",
  "University of Illinois at Urbana-Champaign": "UIUC",
  "University of Michigan": "UMich",
  "Georgia Institute of Technology": "Georgia Tech",
  "University of Washington": "UW",
  "Princeton University": "Princeton",
  "Harvard University": "Harvard",
  "Columbia University": "Columbia",
  "ETH Zurich": "ETH Zurich",
  "École Polytechnique Fédérale de Lausanne": "EPFL",
  "University of Oxford": "Oxford",
  "University of Cambridge": "Cambridge",
  "National University of Singapore": "NUS",
  "Nanyang Technological University": "NTU",
  "University of Tokyo": "UTokyo",
  "Tsinghua University": "Tsinghua",
  "Peking University": "PKU",
  "The Chinese University of Hong Kong": "CUHK",
  "The University of Hong Kong": "HKU",
  "University of Toronto": "UofT"
};
function hasChineseChar(s) { return /[\u3400-\u9FFF]/.test(s || ""); }
function normalizeInstitution(name) {
  const raw = (name || "").trim();
  if (!raw) return "";
  if (hasChineseChar(raw)) return raw;
  for (const [full, abbr] of Object.entries(FAMOUS_ABBREV))
    if (raw.toLowerCase() === full.toLowerCase()) return abbr;
  const famousSet = new Set(Object.values(FAMOUS_ABBREV).map(v => v.toLowerCase()));
  if (famousSet.has(raw.toLowerCase())) return raw;
  return raw;
}

// ==================== ④ Zotero 内容收集器 + 本地 PDF 提取 ====================
async function getChildNotesText(item) {
  if (!USE_NOTES) return "";
  try {
    if (typeof item.getNotes === "function") {
      const ids = await item.getNotes(); if (!ids?.length) return "";
      const buf = [];
      for (const id of ids) {
        try {
          const note = await Zotero.Items.getAsync(id);
          const html = note.getNote() || "";
          const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
          if (text) buf.push(text);
        } catch (_) {}
      }
      return buf.join("\n").slice(0, MAX_NOTES_CHARS);
    }
  } catch (_) {}
  return "";
}
async function getPdfAttachmentIDs(item) {
  try {
    const ids = (await item.getAttachments?.()) || []; const out = [];
    for (const id of ids) {
      const att = await Zotero.Items.getAsync(id);
      if (!att?.isAttachment?.()) continue;
      const mt = (att.attachmentMIMEType || "").toLowerCase();
      if (mt === "application/pdf") out.push(att.id);
    }
    return out;
  } catch (_) { return []; }
}
/** 使用 Zotero 内置全文索引获取 PDF 文本（需已建立索引） */
async function getPdfTextFromFulltextIndex(att) {
  try {
    if (typeof Zotero.Fulltext?.getAttachmentText === "function") {
      const s = await Zotero.Fulltext.getAttachmentText(att);
      if (s) return s;
    }
  } catch (_) {}
  try {
    if (typeof Zotero.Fulltext?.getAttachmentText === "function") {
      const s = await Zotero.Fulltext.getAttachmentText(att.id);
      if (s) return s;
    }
  } catch (_) {}
  try {
    if (typeof Zotero.Fulltext?.getText === "function") {
      const s = await Zotero.Fulltext.getText(att.id);
      if (s) return s;
    }
  } catch (_) {}
  return "";
}
function cleanPdfTextLocal(s) {
  if (!s) return "";
  let t = s.replace(/\r/g, "\n");
  t = t.replace(/\n{2,}/g, "\n\n");
  t = t.replace(/([^\n])\n(?!\n)/g, "$1 "); // 单换行改空格
  t = t.replace(/[ \t]{2,}/g, " ");
  return t.trim();
}
/** 本地读取 PDF 正文，合并并截断到上限 */
async function buildLocalPdfTextForItem(item) {
  if (!LOCAL_PDF_ENABLED) return "";
  const ids = await getPdfAttachmentIDs(item);
  if (!ids.length) return "";
  const parts = [];
  for (const id of ids) {
    try {
      const att = await Zotero.Items.getAsync(id);
      const raw = await getPdfTextFromFulltextIndex(att);
      const clean = cleanPdfTextLocal(raw);
      if (clean) parts.push(clean);
    } catch (e) {
      Zotero.debug("[LocalPDF] read failed: " + (e?.message || e));
    }
  }
  if (!parts.length) return "";
  return parts.join("\n\n").slice(0, LOCAL_PDF_MAX_CHARS);
}
/** 上下文拼接：Title + Abstract + PDFText + Notes + Extra */
async function collectContext(item) {
  const title = item.getField("title") || "";
  const abstractNote = item.getField("abstractNote") || "";
  const extra = item.getField("extra") || "";
  const notesText = await getChildNotesText(item);
  const pdfText = await buildLocalPdfTextForItem(item); // 本地 PDF 正文

  return [
    `Title: ${title}`,
    abstractNote ? `Abstract: ${abstractNote}` : "",
    pdfText ? `PDFText: ${pdfText}` : "",
    notesText ? `Notes: ${notesText}` : "",
    extra ? `Extra: ${extra}` : ""
  ].filter(Boolean).join("\n\n");
}

// ==================== ⑤ 全库结构化标签扫描 & 提示文本构建 ====================
/** 读取全库所有标签（优先用 Zotero.Tags.getAll；失败则回退到遍历 items） */
async function loadAllLibraryTags() {
  try {
    if (typeof Zotero.Tags?.getAll === "function") {
      const tags = await Zotero.Tags.getAll();
      // 标准结构：[{name, type}]；某些版本也可能是字符串数组
      return Array.isArray(tags) ? tags.map(t => (typeof t === "string" ? t : t.name || "")).filter(Boolean) : [];
    }
  } catch (_) {}
  // 回退：遍历全部 items（可能较慢，但可靠）
  try {
    const ids = await Zotero.Items.getAll(); // 可能是 IDs
    const all = [];
    for (const id of ids) {
      try {
        const it = await Zotero.Items.getAsync(id);
        const ts = await it.getTags();
        for (const t of ts || []) all.push(t.tag);
      } catch (_) {}
    }
    return all;
  } catch (_) {
    return [];
  }
}

/** 将标签筛选为结构化 key:value，并统计每个 key 下每个 value 的频次 */
function buildStructuredTagStats(allTagNames) {
  const byKey = {}; // { key: { value: count } }
  let totalCount = 0;
  for (const name of allTagNames) {
    const m = STRUCTURED_TAG_REGEX.exec(name || "");
    if (!m) continue;
    const key = m[1].trim();
    const val = m[2].trim();
    if (!key || !val) continue;
    if (!byKey[key]) byKey[key] = {};
    byKey[key][val] = (byKey[key][val] || 0) + 1;
    totalCount++;
  }
  return { byKey, totalCount };
}

/** 按字段分组生成“现有标签参考”的提示段落文本（可能按频次截断） */
function buildExistingTagsPrompt(byKey, totalCount) {
  // 是否触发“超大库”策略
  const isHuge = totalCount > TAGS_TOTAL_SOFT_TRIGGER;

  // 优先显示核心字段的分组顺序
  const CORE_ORDER = ["institution","method_name","research_content","research_type","robot_name","robot_type","task"];
  const keys = Object.keys(byKey);
  keys.sort((a,b)=>{
    const ia = CORE_ORDER.indexOf(a), ib = CORE_ORDER.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b);
  });

  const sections = [];
  for (const k of keys) {
    const dict = byKey[k];
    const pairs = Object.entries(dict); // [value, count]
    // 按频次降序
    pairs.sort((a,b)=> b[1]-a[1] || a[0].localeCompare(b[0]));
    const limited = isHuge ? pairs.slice(0, TAGS_PER_KEY_SOFT_CAP) : pairs;
    const lines = limited.map(([v,c]) => TAGS_INCLUDE_COUNTS ? `- ${v} (${c})` : `- ${v}`);
    if (!lines.length) continue;
    sections.push(`Existing ${k} tags:\n${lines.join("\n")}`);
  }

  if (!sections.length) return ""; // 无结构化标签则返回空
  return `Use the existing structured tags to standardize your output. 
- Reuse an existing tag if your candidate is semantically equivalent.
- Prefer the most frequent variant (highest count).
- Do NOT invent near-duplicates; snap to the closest existing tag form.
- Keep keys as provided (e.g., method_name/task/robot_type/...).

${sections.join("\n\n")}`;
}

// ==================== ⑥ DeepSeek 调用模块（双阶段） ====================
async function deepseekChat(messages, { temperature = 0.1 } = {}) {
  const resp = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${DEEPSEEK_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ model: MODEL, temperature, messages })
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`DeepSeek HTTP ${resp.status}: ${text}`);
  }
  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error("DeepSeek returned empty content");
  return content;
}

async function stage1Summarize(contextText) {
  const sys = `You are an assistant that distills robotics paper context into a concise bullet summary for information extraction.
Rules:
- Output plain English text, 6-12 short bullets, no JSON, no numbering.
- Keep only facts likely present in the paper: institutions, methods, robot platforms, tasks, datasets, etc.
- Avoid speculation; if unknown, omit.
- Max ~200 words.`;
  const usr = `Context:
${contextText}

Summarize now.`;
  return await deepseekChat([{ role: "system", content: sys }, { role: "user", content: usr }], { temperature: 0.2 });
}

async function stage2Extract(summaryText, existingTagsGuideText) {
  const sys = `IMPORTANT: Your entire response MUST be ONLY valid JSON (no code fences, no commentary).
You extract structured research metadata for robotics papers.

Fields:
- institution: string (CN universities keep Chinese; top global universities use abbreviations like MIT/CMU/UC Berkeley/Stanford/etc.; others keep original full/short name)
- method_name: array of short names; if a variant, use "XXX-like". Prefer common acronym first, optionally full name in parentheses.
- research_content: array of main technical contents (e.g., "GAN", "teacher student framework"), short phrases (<=3 words).
- research_type: string (e.g., "algorithm", "control", "planning", "model", "RL", "vision").
- robot_name: array of platform names exactly as used (e.g., "Unitree G1", "Atlas", "Digit").
- robot_type: array of categories (e.g., "humanoid", "animated humanoid", "bipedal", "quadruped", "manipulator").
- task: array of tasks (e.g., "locomotion", "loco-manipulation", "ladder climbing", "parkour").

Extended fields (optional, max 3) if clearly present:
- dataset, benchmark, sim2real, hardware, sensors, simulator, pretrain, etc.
Use lowercase snake_case for extended field names.

Rules:
- If a field is unknown, OMIT it entirely (do not guess; do not put null/unknown).
- Keep phrases concise (<=3 words) and in English, EXCEPT "institution" rule above.
- Do not include punctuation in values except hyphen inside a method like "ASE-like".
- IMPORTANT: When choosing values for method_name/research_content/research_type/robot_name/robot_type/task and any extended keys,
  you MUST prefer and reuse existing tags provided below if semantically equivalent, and prefer the highest-frequency variant.
`;

  const usr = `Summary:
${summaryText}

${existingTagsGuideText ? `\n\n${existingTagsGuideText}\n` : ""}

Now output ONLY the JSON object with the above fields that are present.`;

  const content = await deepseekChat([{ role: "system", content: sys }, { role: "user", content: usr }], { temperature: 0.1 });

  try { return JSON.parse(content); }
  catch (_) {
    const fixed = extractJsonStrict(content);
    if (!fixed) throw new Error("DeepSeek returned non-JSON or unparsable content");
    return fixed;
  }
}

async function twoStageExtract(contextText, existingTagsGuideText) {
  try {
    const s1 = await stage1Summarize(contextText);
    const s2 = await stage2Extract(s1, existingTagsGuideText);
    return s2;
  } catch (e1) {
    Zotero.debug("[DeepSeek] First attempt failed: " + e1.message);
    await delay(600);
    const s1 = await stage1Summarize(contextText);
    const s2 = await stage2Extract(s1, existingTagsGuideText);
    return s2;
  }
}

// ==================== ⑦ 结果解析 & 规范化 ====================
const CORE_FIELDS = [
  "institution", "method_name", "research_content",
  "research_type", "robot_name", "robot_type", "task"
];
function normalizeParsedForWriting(parsed) {
  const out = {};
  for (const k of CORE_FIELDS) {
    if (!(k in parsed)) continue;
    if (k === "institution" || k === "research_type") {
      const s = (parsed[k] ?? "").toString().trim(); if (s) out[k] = s;
    } else {
      const arr = ensureArray(parsed[k]); if (arr.length) out[k] = arr;
    }
  }
  // 扩展字段（≤ MAX_EXTENDED_FIELDS）
  const known = new Set(CORE_FIELDS); let ext = 0;
  for (const [k, v] of Object.entries(parsed)) {
    if (known.has(k)) continue;
    if (ext >= MAX_EXTENDED_FIELDS) break;
    const arr = ensureArray(v); if (!arr.length) continue;
    out[k] = arr; ext++;
  }
  if (out.institution) out.institution = normalizeInstitution(out.institution);
  return out;
}

// ==================== ⑧ 写入 Zotero（Tags + Extra 智能更新） ====================
async function getExistingTags(item) {
  try { return (await item.getTags())?.map(t => t.tag) || []; }
  catch (_) { return []; }
}
async function writeTags(item, normalizedObj) {
  const existing = new Set(await getExistingTags(item));
  const toAdd = [];
  for (const key of CORE_FIELDS) {
    if (!(key in normalizedObj)) continue;
    if (key === "institution" || key === "research_type") {
      const v = (normalizedObj[key] || "").toString().trim();
      if (v) {
        const tag = `${key}:${v}`;
        if (!existing.has(tag)) toAdd.push(tag);
      }
    } else {
      for (const v of ensureArray(normalizedObj[key])) {
        const tag = `${key}:${v}`;
        if (!existing.has(tag)) toAdd.push(tag);
      }
    }
  }
  // 扩展字段
  const known = new Set(CORE_FIELDS);
  for (const [k, arr] of Object.entries(normalizedObj)) {
    if (known.has(k)) continue;
    for (const v of ensureArray(arr)) {
      const tag = `${k}:${v}`;
      if (!existing.has(tag)) toAdd.push(tag);
    }
  }
  for (const t of dedupe(toAdd)) { try { item.addTag(t); } catch (_) {} }
}
function upsertAiYamlBlock(oldExtra, yamlContent) {
  const header = YAML_BLOCK_HEADER, mark = AI_YAML_MARK;
  const pattern = new RegExp(`${header}\\s*\\n(?:.*?\\n)?\\s*${mark}\\s*\\n[\\s\\S]*?\\n${header}`, "g");
  const newBlock = `${header}\n${mark}\n${yamlContent}\n${header}`;
  if (!oldExtra || !oldExtra.trim()) return newBlock;
  if (pattern.test(oldExtra)) return oldExtra.replace(pattern, newBlock);
  return oldExtra.trimEnd() + "\n\n" + newBlock;
}
async function writeExtraYaml(item, normalizedObj) {
  const yamlObj = {};
  for (const k of CORE_FIELDS) if (k in normalizedObj) yamlObj[k] = normalizedObj[k];
  for (const [k, v] of Object.entries(normalizedObj)) if (!CORE_FIELDS.includes(k)) yamlObj[k] = v;
  const yaml = toYAML(yamlObj); if (!yaml) return;
  const oldExtra = item.getField("extra") || "";
  const nextExtra = upsertAiYamlBlock(oldExtra, yaml);
  item.setField("extra", nextExtra);
}
async function applyToItem(item, parsed) {
  const norm = normalizeParsedForWriting(parsed);
  if (Object.keys(norm).length === 0) return;
  await writeTags(item, norm);
  await writeExtraYaml(item, norm);
  await item.saveTx();
}

// ==================== ⑨ 主流程（使用注入的 items） ====================
(async ({ items }) => {
  try {
    if (!DEEPSEEK_API_KEY || /YOUR_DEEPSEEK_API_KEY_HERE/i.test(DEEPSEEK_API_KEY)) {
      return Zotero.alert("请先在脚本顶部设置 DEEPSEEK_API_KEY");
    }
    if (!items?.length) return Zotero.alert("未选择任何条目");

    // 预加载“全库结构化标签”并构建提示文本（一次生成，全局复用）
    const allTagNames = await loadAllLibraryTags();
    const { byKey, totalCount } = buildStructuredTagStats(allTagNames);
    const existingTagsGuideText = buildExistingTagsPrompt(byKey, totalCount);

    let success = 0, skipped = 0, failed = 0;
    for (const item of items) {
      try {
        if (!item?.isRegularItem || !item.isRegularItem()) { skipped++; continue; }
        const ctx = await collectContext(item);
        if (!ctx || !ctx.trim()) { skipped++; continue; }
        const parsed = await twoStageExtract(ctx, existingTagsGuideText);
        if (!parsed || Object.keys(parsed).length === 0) { skipped++; continue; }
        await applyToItem(item, parsed);
        success++;
      } catch (e) {
        failed++; Zotero.debug("[DeepSeek-LocalPDF+Tags] Item failed: " + (e?.message || e));
      }
    }
    Zotero.alert(`完成：成功 ${success}，跳过 ${skipped}，失败 ${failed}`);
  } catch (e) {
    Zotero.alert("运行失败: " + (e?.message || e));
  }
})({ items });
