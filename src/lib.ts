// ---- BUDGET ----

export const FM_MAX_TOKENS = 5_500;

export function estTokens(s: string): number {
  let digits = 0, punct = 0, letters = 0, spaces = 0;
  for (const ch of s) {
    if (/\d/.test(ch)) digits++;
    else if (/[A-Za-z]/.test(ch)) letters++;
    else if (/\s/.test(ch)) spaces++;
    else punct++;
  }
  return Math.ceil(digits + punct + letters / 3.2 + spaces * 0.15);
}

export function fit(text: string, max = FM_MAX_TOKENS): string {
  const est = estTokens(text);
  if (est <= max) return text;
  const half = Math.floor((text.length * (max / est) - 40) / 2);
  return `${text.slice(0, half)}\n[... ${text.length - 2 * half} chars cut ...]\n${text.slice(-half)}`;
}

export function chunks(text: string, maxTokens: number): string[] {
  const out: string[] = [];
  let cur = "";
  let curTokens = 0;
  for (const line of text.split("\n")) {
    const t = estTokens(line) + 1;
    if (cur && curTokens + t > maxTokens) {
      out.push(cur);
      cur = "";
      curTokens = 0;
    }
    cur += (cur ? "\n" : "") + line;
    curTokens += t;
  }
  if (cur) out.push(cur);
  return out;
}

// ---- QUOTES ----

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

export function parseAnswer(out: string): { answer: string; quotes: string[] } | null {
  if (out.trim() === "NOT_FOUND") return null;
  const m = out.match(/ANSWER:\s*([\s\S]*?)(?:\n\s*QUOTES:\s*\n?([\s\S]*))?$/);
  if (!m) return { answer: out.trim(), quotes: [] };
  const quotes = (m[2] ?? "")
    .split("\n")
    .map((l) => l.replace(/^\s*(?:[-*>]|\d+[.)])\s*/, "").replace(/^["'`]|["'`]$/g, "").trim())
    .filter((l) => l && l !== "NOT_FOUND");
  return { answer: m[1].replace(/\s*NOT_FOUND\s*$/, "").trim(), quotes };
}

export function locate(quotes: string[], file: string): string[] {
  const lines = file.split("\n");
  const normed = lines.map(norm);
  const out: string[] = [];
  for (const q of quotes) {
    const nq = norm(q.replace(/^\s*L?\d+[:-]\s*/, ""));
    if (nq.length < 3) continue;
    const i = normed.findIndex((l) => l.includes(nq));
    if (i >= 0) out.push(`L${i + 1}: ${lines[i].trim()}`);
  }
  return [...new Set(out)];
}

export function stripLeadIn(out: string): string {
  const url = out.match(/[a-z][a-z0-9+.-]*:\/\/\S+/i);
  if (url) return url[0].replace(/[)"'`.,]+$/, "");
  return out
    .replace(/^[\s\S]*?(?:payload|content|data|decodes? to|value)[^:\n]*:\s*/i, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();
}

// ---- GROUNDING ----

export function anchors(note: string): string[] {
  const found = [
    ...note.matchAll(/`([^`]+)`/g),
    ...note.matchAll(/(?:~|\.{0,2})?\/?[\w.-]+(?:\/[\w.-]+)+/g),
    ...note.matchAll(/\b[\w-]+\.(?:ts|js|py|swift|md|json|ya?ml|toml|sh|rs|go|c|h|txt|log)\b/g),
    ...note.matchAll(/\b\d{2,}(?:\.\d+)?\b/g),
    ...note.matchAll(/\b[a-z]+[A-Z]\w*\b|\b[a-z]+_[a-z_\d]+\b/g),
  ].map((m) => (m[1] ?? m[0]).trim());
  return [...new Set(found)].filter((a) => a.length > 1);
}

export function grounded(note: string, source: string): { ok: boolean; missing: string[] } {
  const missing = anchors(note).filter((a) => !source.includes(a));
  return { ok: missing.length === 0, missing };
}

// ---- MEMORY ----

export interface Entry { date: string; head: string; body: string }

export function parseEntries(text: string): Entry[] {
  return text
    .split(/^(?=## \d{4}-\d{2}-\d{2} )/m)
    .filter((b) => b.startsWith("## "))
    .map((b) => {
      const [head, ...rest] = b.split("\n");
      return { date: head.slice(3, 13), head, body: rest.join("\n").trim() };
    });
}

export const renderEntries = (es: Entry[]) => es.map((e) => `${e.head}\n${e.body}\n`).join("\n");

export function weekOf(date: string): string {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T12:00:00`) - Date.parse(`${a}T12:00:00`)) / 86_400_000);
}
