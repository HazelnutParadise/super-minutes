// Probe gemma4:e4b with the same prompt the report API uses, then print the
// raw `message.content` so we can see whether it parses as JSON. Run with:
//   node scripts/probe-ollama.mjs
// Override the URL with OLLAMA_URL=... if needed.

const OLLAMA = process.env.OLLAMA_URL ?? "http://100.79.146.102:11434";
const MODEL = process.env.OLLAMA_MODEL ?? "gemma4:e4b";

const languageName = "Traditional Chinese (zh-TW)";

const SYSTEM = `You are a senior meeting minutes writer. Convert the diarized transcript into a structured meeting report.

# Rules

1. **Language**: write every string value (title, summary, conclusions, headings, points, tasks, owners, due) in ${languageName}. Keep keys in English.
2. **Output**: emit ONE JSON object and NOTHING ELSE. No prose, no markdown fences, no \`\`\`json blocks, no leading commentary. Your reply MUST start with { and end with }.
3. **Fidelity**: only use facts present in the transcript. Don't invent attendees, decisions, numbers, or commitments.
4. **Style**: short declarative sentences. No filler like "在這次會議中". \`title\` ≤ 18 chars. Each \`heading\` ≤ 16 chars.

# Example output

{
  "title": "Sprint 22 範圍確認",
  "summary": "團隊敲定下個 Sprint 只做離線快取的目錄與詳情頁，個人化推延。",
  "conclusions": [
    "Sprint 22 範圍鎖定為離線快取 v1。",
    "個人化頁面延至 Sprint 23 再評估。"
  ],
  "topics": [
    {
      "heading": "Sprint 範圍",
      "points": [
        "離線快取只做目錄與詳情兩條路由。",
        "個人化頁面因隱私風險暫不納入。"
      ]
    }
  ],
  "actions": [
    { "task": "提交離線快取 v1 PR", "owner": "志遠", "due": "本週五" }
  ]
}

If a field has no content, use an empty string, empty array, or null — do NOT omit the key.`;

const transcript = `[00:00] 怡君: 好我們今天討論 Sprint 22 範圍，要決定離線快取要不要做。
[00:08] 志遠: 我覺得快取要做，但只做目錄頁跟詳情頁兩個路由，個人化先不要碰。
[00:18] Naomi: 同意，個人化會踩到權限，設計上也比較傾向先做匿名路由。
[00:28] 怡君: OK，那就敲定 Sprint 22 上線離線快取 v1，目錄跟詳情，個人化推到 23。
[00:38] 志遠: 我這邊負責 service worker，週五前 PR。
[00:45] Naomi: 我來把離線徽章補上。`;

const body = {
  model: MODEL,
  stream: false,
  format: "json",
  options: { temperature: 0.1, top_p: 0.9, num_ctx: 16384 },
  keep_alive: "10m",
  messages: [
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content: `# Transcript\n\n${transcript}\n\nNow emit the JSON object. Begin with { right away.`,
    },
  ],
};

const t0 = Date.now();
const r = await fetch(`${OLLAMA}/api/chat`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const text = await r.text();
const ms = Date.now() - t0;
console.log(`[probe] status=${r.status} ms=${ms} bytes=${text.length}`);
if (!r.ok) {
  console.error(text);
  process.exit(1);
}
const reply = JSON.parse(text);
const content = reply.message?.content ?? "";
console.log("---RAW CONTENT START---");
console.log(content);
console.log("---RAW CONTENT END---");
try {
  const parsed = JSON.parse(content.trim());
  console.log("[probe] strict JSON.parse: OK");
  console.log(
    `[probe] keys=${Object.keys(parsed).join(",")}  topics=${parsed.topics?.length ?? "?"}  actions=${parsed.actions?.length ?? "?"}`
  );
} catch (e) {
  console.log(`[probe] strict JSON.parse FAILED: ${e.message}`);
  // Try the balanced-brace extraction.
  const start = content.indexOf("{");
  if (start === -1) {
    console.log("[probe] no { found");
  } else {
    let depth = 0,
      inStr = false,
      esc = false,
      end = -1;
    for (let i = start; i < content.length; i++) {
      const ch = content[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end > -1) {
      const sliced = content.slice(start, end + 1);
      try {
        JSON.parse(sliced);
        console.log("[probe] balanced-brace slice: OK");
      } catch (e2) {
        console.log(`[probe] balanced slice still bad: ${e2.message}`);
      }
    } else {
      console.log("[probe] balanced slice: no matching close }");
    }
  }
}
