// Fire 3 simultaneous /api/report calls against the local BFF, read the
// first ~5s of each NDJSON stream, then abort. We're only interested in
// confirming the queue events arrive in the right shape — the first
// request should go straight to `processing`, the rest should emit
// `queued(ahead=N)` first.

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const transcript =
  "[00:00] A: 我們今天要決定 Sprint 22 範圍。\n[00:08] B: 我覺得只做離線快取。\n[00:18] A: 好，那就敲定離線快取，週五前 PR。";

async function probe(label) {
  const ctrl = new AbortController();
  // Abort after 6 seconds — enough to see queued/processing events.
  setTimeout(() => ctrl.abort(), 6_000);
  const events = [];
  try {
    const r = await fetch(`${BASE}/api/report`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        transcript,
        languageName: "Traditional Chinese (zh-TW)",
      }),
      signal: ctrl.signal,
    });
    if (!r.body) return { label, status: r.status, events: ["no body"] };
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (value) buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const m = JSON.parse(line);
          if (m.type === "queued") events.push(`queued(ahead=${m.ahead})`);
          else if (m.type === "result")
            events.push(`result(status=${m.status})`);
          else events.push(m.type);
        } catch {}
      }
      if (done) break;
    }
    return { label, status: r.status, events };
  } catch (e) {
    return { label, status: "abort", events, error: String(e).slice(0, 80) };
  }
}

const t0 = Date.now();
const results = await Promise.all([probe("A"), probe("B"), probe("C")]);
const elapsed = Date.now() - t0;
console.log(`Elapsed: ${elapsed}ms`);
for (const r of results) {
  console.log(
    `[${r.label}] status=${r.status} events=${r.events.slice(0, 10).join(" → ")}${r.events.length > 10 ? " → …" : ""}`
  );
}
