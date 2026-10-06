import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Input, matchesKey, Text, truncateToWidth, wrapTextWithAnsi, type OverlayHandle } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  chunks, cleanPath, daysBetween, estTokens, fit, FM_MAX_TOKENS, grounded, matchName, locate, parseAnswer, parseEntries, renderEntries, stripLeadIn, weekOf,
} from "../src/lib.ts";

// ---- PROCESS ----

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HELPER = join(ROOT, "helper", "applepi");

function run(cmd: string, args: string[], input?: string, timeout = 60_000): Promise<string | null> {
  return new Promise((done) => {
    const child = execFile(cmd, args, { timeout, maxBuffer: 1 << 23 }, (err, out) => done(err ? null : out.trim()));
    if (input !== undefined) child.stdin?.end(input);
  });
}

function runErr(cmd: string, args: string[], input?: string, timeout = 60_000): Promise<{ out: string; err: string | null }> {
  return new Promise((done) => {
    const child = execFile(cmd, args, { timeout, maxBuffer: 1 << 23 }, (err, out, stderr) =>
      done({ out: out.trim(), err: err ? (stderr.trim() || err.message) : null }));
    if (input !== undefined) child.stdin?.end(input);
  });
}

// ---- FM ----

let queue: Promise<unknown> = Promise.resolve();

function fm(args: string[], timeout = 60_000): Promise<string | null> {
  const call = queue.then(() =>
    run("fm", ["respond", "--no-stream", "-g", "--guardrails", "permissive-content-transformations", ...args], undefined, timeout));
  queue = call.catch(() => null);
  return call;
}

const ask = (instructions: string, content: string, question: string, timeout?: number) =>
  fm(["-i", instructions, "--text", fit(content), question], timeout);

const helperReady = () => existsSync(HELPER);
const BUILD_HINT = `apple-pi: helper not built. Run: swiftc -O ${HELPER}.swift -o ${HELPER}`;

// ---- HELPERS ----

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });

function messageText(m: any): string {
  if (typeof m?.content === "string") return m.content;
  return (m?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
}

function transcript(messages: any[], maxChars: number): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === "user") lines.push(`USER: ${messageText(m)}`);
    if (m.role === "assistant") {
      const t = messageText(m);
      if (t) lines.push(`ASSISTANT: ${t}`);
      for (const c of m.content ?? []) {
        if (c.type === "toolCall") lines.push(`TOOL CALL: ${c.name} ${JSON.stringify(c.arguments).slice(0, 300)}`);
      }
    }
    if (m.role === "toolResult") lines.push(`TOOL RESULT (${m.toolName}${m.isError ? ", error" : ""}): ${messageText(m).slice(0, 400)}`);
  }
  return lines.join("\n").slice(-maxChars);
}

function findFile(cwd: string, raw: string): string {
  const cleaned = cleanPath(raw).replace(/^~(?=\/|$)/, homedir());
  const full = resolve(cwd, cleaned);
  if (existsSync(full)) return full;
  const dir = dirname(full);
  const hit = existsSync(dir) ? matchName(full.slice(dir.length + 1), readdirSync(dir)) : undefined;
  if (hit) return join(dir, hit);
  throw new Error(`file not found: ${full}`);
}

const today = () => new Date().toLocaleDateString("en-CA");
const clock = () => new Date().toTimeString().slice(0, 5);
const tilde = (p: string) => p.replace(homedir(), "~");

// ---- MEMORY ----

const MEM = process.env.APPLE_PI_MEMORY ?? join(homedir(), ".apple-pi", "memory");
const memFile = (name: string) => join(MEM, name);
const readMem = (name: string) => (existsSync(memFile(name)) ? readFileSync(memFile(name), "utf8") : "");
const INJECT_MAX_CHARS = 3_200;

const DAY_INSTR = `You condense one day of work log notes into one short paragraph (max 4 sentences).
Keep file names, paths, commands, and numbers exactly as written. Do not add facts. No other text.`;

const oneLine = (s: string, max: number) => s.replace(/\*\*|^#+\s*|`/gm, "").replace(/\s+/g, " ").trim().slice(0, max);

function capture(messages: any[], cwd: string): boolean {
  const lastUser = messages.findLastIndex((m) => m.role === "user");
  if (lastUser < 0) return false;
  const turn = messages.slice(lastUser);
  const prompt = messageText(turn[0]);
  if (!prompt.trim()) return false;
  const calls = turn.flatMap((m) => (m.content ?? []).filter((c: any) => c.type === "toolCall"));
  const failed = turn.filter((m) => m.role === "toolResult" && m.isError).length;
  const answer = messageText(turn.findLast((m) => m.role === "assistant"));
  const tools = calls.length
    ? ` | tools: ${[...new Set(calls.map((c: any) => c.name))].join(", ")}${failed ? ` (${failed} failed)` : ""}`
    : "";
  const note = `asked: ${oneLine(prompt, 160)}${tools} | result: ${oneLine(answer, 200)}`;
  mkdirSync(MEM, { recursive: true });
  appendFileSync(memFile("now.md"), `## ${today()} ${clock()} | ${tilde(cwd)}\n${note}\n\n`);
  return true;
}

async function rollup(): Promise<void> {
  if (!existsSync(memFile("now.md"))) return;
  const entries = parseEntries(readMem("now.md"));
  const past = [...new Set(entries.map((e) => e.date))].filter((d) => d < today());
  for (const day of past) {
    const dayEntries = entries.filter((e) => e.date === day);
    const raw = renderEntries(dayEntries);
    const out = await ask(DAY_INSTR, raw, "Write the paragraph.", 60_000);
    const summary = out && grounded(out, raw).ok ? out : raw.trim();
    writeFileSync(memFile(`today-${day}.md`), `## ${day}\n${summary}\n`);
    const keep = parseEntries(readMem("now.md")).filter((e) => e.date !== day);
    writeFileSync(memFile("now.md"), renderEntries(keep));
  }
  const days = readdirSync(MEM).filter((f) => /^today-\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort();
  for (const f of days) {
    const day = f.slice(6, 16);
    if (daysBetween(day, today()) <= 7) continue;
    appendFileSync(memFile("archive.md"), `### week of ${weekOf(day)}\n${readFileSync(join(MEM, f), "utf8")}\n`);
    rmSync(join(MEM, f));
  }
  const recent = readdirSync(MEM).filter((f) => /^today-/.test(f)).sort().reverse()
    .map((f) => readFileSync(join(MEM, f), "utf8").trim());
  writeFileSync(memFile("recent.md"), `# Recent\n\n${recent.join("\n\n")}\n`);
}

function memoryBlock(): string {
  const core = readMem("core.md").trim();
  const recent = readMem("recent.md").replace(/^# Recent\s*/, "").trim();
  const now = parseEntries(readMem("now.md")).slice(-5).map((e) => `${e.head.slice(3)}: ${e.body}`).join("\n");
  const parts = [
    core && `User preferences and facts. Follow these:\n${core}`,
    now && `Earlier today:\n${now}`,
    recent && `Recent days:\n${recent}`,
  ].filter(Boolean).join("\n\n");
  if (!parts) return "";
  const body = parts.length > INJECT_MAX_CHARS ? `${parts.slice(0, INJECT_MAX_CHARS)}\n[...]` : parts;
  return `# Memory (from earlier sessions; use memory_search for more)\n${body}`;
}

// ---- PANEL ----

type Turn = { q: string; a: string };

class FmPanel {
  focused = false;
  input = new Input({ prompt: "\u203a " });

  constructor(
    private tui: any,
    private theme: any,
    private turns: Turn[],
    private onClose: () => void,
    private answer: (q: string) => Promise<string>,
  ) {
    this.input.onSubmit = (v) => void this.submit(v);
  }

  async submit(v: string) {
    const q = v.trim();
    if (!q) return;
    this.input.setValue("");
    const turn = { q, a: "\u2026" };
    this.turns.push(turn);
    this.tui.requestRender();
    turn.a = await this.answer(q);
    this.tui.requestRender();
  }

  handleInput(data: string) {
    if (matchesKey(data, "escape") || matchesKey(data, PANEL_KEY)) return this.onClose();
    this.input.handleInput(data);
    this.tui.requestRender();
  }

  handleMouse(e: { type: string; button: string }) {
    return e.button === "left" && e.type === "press" ? { focus: true } : { handled: true };
  }

  invalidate() {
    this.input.invalidate();
  }

  render(width: number): string[] {
    const th = this.theme;
    const w = Math.max(1, width - 2);
    const b = (s: string) => th.fg("border", s);
    const row = (s: string) => b("\u2502") + truncateToWidth(s, w, "\u2026", true) + b("\u2502");
    const body = this.turns.flatMap((t) => [
      ...wrapTextWithAnsi(th.fg("accent", "\u203a ") + th.fg("dim", t.q), w - 1),
      ...wrapTextWithAnsi(t.a, w - 1),
      "",
    ]).map((l) => ` ${l}`);
    const height = Math.max(3, this.tui.terminal.rows - PANEL_FREE_ROWS - 4);
    const shown = body.slice(-height);
    if (!shown.length) shown.push(th.fg("dim", " Ask fm. Esc closes. Click to type."));
    while (shown.length < height) shown.push("");
    this.input.focused = this.focused;
    return [
      b("\u256d\u2500") + th.fg("accent", " \uF8FF fm ") + b("\u2500".repeat(Math.max(0, w - 7)) + "\u256e"),
      ...shown.map(row),
      b("\u251c" + "\u2500".repeat(w) + "\u2524"),
      ...this.input.render(w).map(row),
      b("\u2570" + "\u2500".repeat(w) + "\u256f"),
    ];
  }
}

const PANEL_KEY = "ctrl+shift+a";
const PANEL_FREE_ROWS = 8;

// ---- EXTENSION ----

export default function (pi: ExtensionAPI) {
  let thinkOn = true;
  let base: string | undefined;
  let lastSet: string | undefined;
  let lastRoute = "-";
  let memory: string | undefined;
  let lastMessages: any[] = [];
  let captures = 0;

  const status = (ctx: ExtensionContext) => {
    if (ctx.hasUI) ctx.ui.setStatus("apple-pi", `\uF8FF ${lastRoute} · mem +${captures}`);
  };

  // ---- LIFECYCLE ----

  pi.on("session_start", async (_e, ctx) => {
    if (!helperReady() && ctx.hasUI) ctx.ui.notify(BUILD_HINT, "warning");
    void rollup().catch(() => {});
    status(ctx);
  });

  pi.on("agent_end", async (e, ctx) => {
    lastMessages = e.messages as any[];
    try {
      if (capture(lastMessages, ctx.cwd)) captures++;
      status(ctx);
    } catch {}
  });

  // ---- THINK ----

  pi.on("before_agent_start", async (e, ctx) => {
    memory ??= memoryBlock();
    if (memory) e.systemPromptOptions.sections = { ...(e.systemPromptOptions.sections ?? {}), "apple-pi-memory": memory };

    if (!thinkOn || !ctx.model?.reasoning || !helperReady()) return;
    const cur = pi.getThinkingLevel();
    if (base === undefined || cur !== lastSet) base = cur;
    if (base === "off") return;
    const route = await run(HELPER, ["classify"], e.prompt.slice(0, 4000), 5_000);
    if (route !== "think" && route !== "no_think") return;
    pi.setThinkingLevel(route === "think" ? (base as any) : "off");
    lastSet = pi.getThinkingLevel();
    lastRoute = route;
    status(ctx);
  });

  pi.registerCommand("fm-think", {
    description: "Turn the fm think/no-think picker on or off",
    handler: async (args, ctx) => {
      thinkOn = args.trim() !== "off";
      if (!thinkOn && base) pi.setThinkingLevel(base as any);
      ctx.ui.notify(`apple-pi think picker: ${thinkOn ? "on" : "off"}`, "info");
    },
  });

  // ---- SIDE ----

  pi.registerEntryRenderer<{ q: string; a: string }>("apple-pi-side", (entry, _opts, theme) => {
    const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
    box.addChild(new Text(`${theme.fg("accent", "\uF8FF fm")} ${theme.fg("dim", entry.data?.q ?? "")}`, 0, 0));
    box.addChild(new Text(entry.data?.a ?? "", 0, 0));
    return box;
  });

  const side = (withContext: boolean) => async (args: string, ctx: ExtensionContext) => {
    const q = args.trim();
    if (!q) return ctx.ui.notify(`usage: /${withContext ? "fm+" : "fm"} <question>`, "warning");
    const a = withContext
      ? await ask("Answer the question about this agent session briefly. Use only the transcript.", transcript(lastMessages, 12_000), q)
      : await fm(["-i", "Answer briefly and precisely. Say if you are unsure.", q]);
    const answer = a ?? "fm did not answer (unavailable, timed out, or refused).";
    pi.appendEntry("apple-pi-side", { q, a: answer });
    if (!ctx.hasUI) process.stdout.write(`[fm] ${answer}\n`);
  };

  const turns: Turn[] = [];
  let panel: OverlayHandle | undefined;

  const panelAnswer = async (q: string) => {
    const withContext = q.startsWith("+");
    const question = withContext ? q.slice(1).trim() : q;
    const earlier = turns.slice(0, -1).slice(-6).map((t) => `USER: ${t.q}\nFM: ${t.a}`).join("\n");
    const content = [
      withContext ? `SESSION TRANSCRIPT:\n${transcript(lastMessages, 8_000)}` : "",
      earlier ? `EARLIER CHAT:\n${earlier}` : "",
    ].filter(Boolean).join("\n\n");
    const instr = "You are a side chat next to a coding agent. Answer briefly and precisely. Say if you are unsure.";
    const a = content ? await ask(instr, content, question) : await fm(["-i", instr, question]);
    return a ?? "fm did not answer (unavailable, timed out, or refused).";
  };

  const togglePanel = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    if (!panel) {
      void ctx.ui.custom<void>(
        (tui, theme) => {
          tui.addInputListener(() => {
            if (panel && !panel.isFocused()) panel.unfocus();
            return undefined;
          });
          return new FmPanel(tui, theme, turns, () => {
            panel?.unfocus();
            panel?.setHidden(true);
          }, panelAnswer);
        },
        {
          overlay: true,
          overlayOptions: { anchor: "top-right", width: "35%", minWidth: 32, margin: { top: 1, right: 1 }, visible: (w) => w >= 100 },
          onHandle: (h) => { panel = h; },
        },
      );
      return;
    }
    if (panel.isFocused()) {
      panel.unfocus();
      panel.setHidden(true);
    } else {
      panel.setHidden(false);
      panel.focus();
    }
  };

  pi.registerCommand("fm-panel", { description: "Open the fm side chat panel (Ctrl+Shift+A)", handler: async (_a, ctx) => togglePanel(ctx) });
  pi.registerShortcut(PANEL_KEY, { description: "Toggle the fm side chat panel", handler: (ctx) => togglePanel(ctx) });

  pi.registerCommand("fm", { description: "Ask Apple fm a side question (not added to the model's context)", handler: side(false) });
  pi.registerCommand("fm+", { description: "Ask fm about the current session (not added to the model's context)", handler: side(true) });

  // ---- TOOLS ----

  pi.registerTool({
    name: "read_qr", label: "Read QR",
    description: "Decode a QR code or barcode in an image file. Returns the exact payload. Use instead of looking at the image yourself.",
    parameters: Type.Object({ path: Type.String({ description: "Path to the image file" }) }),
    async execute(_id, p, _s, _u, ctx) {
      const out = await fm(["--tool", "barcode", "--image", findFile(ctx.cwd, p.path), "--text",
        "Decode the barcode or QR code in this image and output only its payload."]);
      if (!out) throw new Error("fm could not decode the image");
      return text(stripLeadIn(out));
    },
  });

  pi.registerTool({
    name: "describe_image", label: "Describe image",
    description: "Answer a question about an image file in under 100 words, using an on-device vision model. Use it when you cannot view images yourself, or for large screenshots or photos to save context. Never use it for exact text, code, or IDs.",
    parameters: Type.Object({
      path: Type.String({ description: "Path to the image file" }),
      question: Type.String({ description: "What you want to know about the image" }),
    }),
    async execute(_id, p, _s, _u, ctx) {
      const out = await fm(["--image", findFile(ctx.cwd, p.path), "--text", `${p.question} Answer in under 100 words.`]);
      if (!out) throw new Error("fm could not describe the image");
      return text(out);
    },
  });

  pi.registerTool({
    name: "transcribe_audio", label: "Transcribe audio",
    description: "Transcribe speech in an audio file (wav, m4a, aiff, mp3, caf) to text with on-device speech recognition. Use it for any question about what a recording says.",
    parameters: Type.Object({
      path: Type.String({ description: "Path to the audio file" }),
      locale: Type.Optional(Type.String({ description: "Speech locale, for example en-US (default) or es-ES" })),
    }),
    async execute(_id, p, _s, _u, ctx) {
      if (!helperReady()) throw new Error(BUILD_HINT);
      const r = await runErr(HELPER, ["transcribe", findFile(ctx.cwd, p.path), p.locale ?? "en-US"], undefined, 300_000);
      if (r.err) throw new Error(r.err);
      return text(r.out || "(no speech found)");
    },
  });

  pi.registerTool({
    name: "translate", label: "Translate",
    description: "Translate text between languages with on-device translation. Fast and exact for installed language pairs. Use language codes such as en, es, de, ja, zh-Hans.",
    parameters: Type.Object({
      text: Type.String({ description: "Text to translate" }),
      from: Type.String({ description: "Source language code, for example ja" }),
      to: Type.String({ description: "Target language code, for example en" }),
    }),
    async execute(_id, p) {
      if (!helperReady()) throw new Error(BUILD_HINT);
      const r = await runErr(HELPER, ["translate", p.from, p.to], p.text, 60_000);
      if (r.err) throw new Error(r.err);
      return text(r.out);
    },
  });

  pi.registerTool({
    name: "ask_file", label: "Ask file",
    description: "Answer a question about a LARGE file (logs, long docs, data dumps over ~200 lines) without loading it into your context. An on-device model reads the file and returns a short answer plus exact lines with line numbers. Use this instead of read for big files. Give pattern (a regex) if you know a keyword. Do not use it for small files, edits, counting, or exact matches (use grep).",
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file" }),
      question: Type.String({ description: "What you want to know" }),
      pattern: Type.Optional(Type.String({ description: "Optional regex to pre-filter lines" })),
    }),
    async execute(_id, p, _s, _u, ctx) {
      const path = findFile(ctx.cwd, p.path);
      const file = readFileSync(path, "utf8");
      return text(await askFile(file, path, p.question, p.pattern));
    },
  });

  pi.registerTool({
    name: "memory_search", label: "Search memory",
    description: "Search your long-term memory of earlier sessions (work logs and facts) for a keyword or regex. Use it when the user refers to earlier work you do not see in context.",
    parameters: Type.Object({ query: Type.String({ description: "Keyword or regex, case-insensitive" }) }),
    async execute(_id, p) {
      if (!existsSync(MEM)) return text("No memory yet.");
      const out = (await run("rg", ["-i", "-n", "-C", "2", "--no-heading", "-e", p.query, MEM]))
        ?? (await run("grep", ["-r", "-i", "-n", "-E", "-C", "2", "-e", p.query, MEM]));
      return text(out ? out.replaceAll(MEM + "/", "").slice(0, 8_000) : `No memory matches "${p.query}".`);
    },
  });

  // ---- MEMORY COMMANDS ----

  pi.registerCommand("remember", {
    description: "Save a durable fact to apple-pi core memory",
    handler: async (args, ctx) => {
      const fact = args.trim();
      if (!fact) return ctx.ui.notify("usage: /remember <fact>", "warning");
      mkdirSync(MEM, { recursive: true });
      appendFileSync(memFile("core.md"), `- ${fact}\n`);
      memory = undefined;
      ctx.ui.notify(`remembered: ${fact}`, "info");
    },
  });

  pi.registerCommand("memory", {
    description: "Show apple-pi memory tiers",
    handler: async (_args, ctx) => {
      if (!existsSync(MEM)) return ctx.ui.notify("no memory yet", "info");
      const sizes = readdirSync(MEM).sort().map((f) => `${f} ${statSync(join(MEM, f)).size}b`).join("\n");
      const block = memoryBlock() || "(nothing injected)";
      pi.appendEntry("apple-pi-side", { q: "/memory", a: `${tilde(MEM)}\n${sizes}\n\ninjected:\n${block}` });
      if (!ctx.hasUI) process.stdout.write(`${sizes}\n\n${block}\n`);
    },
  });
}

// ---- ASK FILE ----

const ANSWER_INSTR = `You answer a question using only the provided text. Reply in exactly this format:
ANSWER: <one or two sentences>
QUOTES:
<each supporting line copied exactly from the text, one per line>
If the text does not contain the answer, reply exactly NOT_FOUND.`;

const SCAN_INSTR = `Copy every line from the text that helps answer the question, exactly as written, one per line. No other words.
If no line helps, reply exactly NOT_FOUND.`;

const SCAN_CHUNK_TOKENS = 5_000;
const SCAN_MAX_BYTES = 200_000;

async function askFile(file: string, path: string, question: string, pattern?: string): Promise<string> {
  let material = file;
  if (pattern) {
    const hits = await run("rg", ["-n", "-C", "3", "--no-heading", "-e", pattern, path])
      ?? (await run("grep", ["-n", "-E", "-C", "3", "-e", pattern, path]));
    if (!hits) return `No lines match /${pattern}/.`;
    material = hits;
  } else if (estTokens(file) > FM_MAX_TOKENS) {
    if (file.length > SCAN_MAX_BYTES) return `File is ${file.length} bytes. Over ${SCAN_MAX_BYTES} bytes, pass a pattern.`;
    const found: string[] = [];
    let failed = 0;
    for (const c of chunks(file, SCAN_CHUNK_TOKENS)) {
      const out = await ask(SCAN_INSTR, c, question, 60_000);
      if (out === null) failed++;
      else if (out.trim() !== "NOT_FOUND") found.push(...out.split("\n"));
    }
    const lines = locate(found, file);
    const gap = failed ? ` (${failed} chunks could not be read; retry with a pattern)` : "";
    if (!lines.length) return `NOT_FOUND: no relevant lines in the file.${gap}`;
    material = lines.join("\n") + gap;
  }
  const out = await ask(ANSWER_INSTR, material, question, 60_000);
  if (!out) return "fm did not answer (unavailable, timed out, or refused).";
  const parsed = parseAnswer(out);
  if (!parsed) return "NOT_FOUND: the file does not answer this.";
  const lines = locate(parsed.quotes, file);
  return `${parsed.answer}\n${lines.length ? `\nLines:\n${lines.join("\n")}` : "\n(no verified quotes; check with grep)"}`;
}
