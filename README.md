# apple-pi

apple-pi is a [pi](https://github.com/earendil-works/pi) extension. It adds Apple on-device models to pi as a helper for the main model. The main model can be any model that pi supports: a local Ollama model, llama.cpp, or a cloud model.

apple-pi does not replace the main model. It does small jobs on the Mac so that the main model saves time and context.

## Features

| Feature | What it does | Uses |
|---|---|---|
| Think picker | Before each prompt, it decides if the prompt needs reasoning. Easy prompts run with thinking off. | Apple Foundation Model |
| `/fm <question>` | Answers a side question. The answer does not go into the main model's context. | Apple Foundation Model |
| `/fm+ <question>` | Answers a side question about the current session. | Apple Foundation Model |
| `/fm-panel` | Opens a side chat with fm on the right side of pi. The terminal must be 100 or more columns wide. | Apple Foundation Model |
| `read_qr` tool | Decodes a QR code or barcode in an image. | Apple Foundation Model with the barcode tool |
| `transcribe_audio` tool | Converts speech in an audio file to text. | Apple Speech |
| `translate` tool | Translates text between installed language pairs. | Apple Translation |
| `ask_file` tool | Answers a question about a large file. It returns exact lines with line numbers. | Apple Foundation Model |
| `describe_image` tool | Describes an image in under 100 words. | Apple Foundation Model |
| Memory | Keeps a log of each task, rolls it up by day and by week, and adds a short summary to each new session. | Plain code and Apple Foundation Model |
| `memory_search` tool | Searches the memory files with a keyword or regex. | ripgrep |

## Requirements

- macOS 26 or later on Apple silicon, with Apple Intelligence turned on.
- The `fm` command (`/usr/bin/fm`).
- Xcode Command Line Tools, for `swiftc`.
- pi 1.0 or later.
- Optional: ripgrep (`rg`). apple-pi uses `grep` if `rg` is not installed.

## Install

1. Build the helper:

   ```sh
   cd apple-pi
   swiftc -O helper/applepi.swift -o helper/applepi
   ```

2. Add the package to pi:

   ```sh
   pi install ./apple-pi
   ```

3. Start pi. The status line shows ` - · mem +0`.

To try apple-pi for one run without installing it, use `pi -e ./apple-pi`.

## Recommended model settings for Ollama

apple-pi does not register models. If you use Ollama, add the model to `~/.pi/agent/models.json` like this:

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://127.0.0.1:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [
        {
          "id": "qwen3.5:4b-mlx",
          "input": ["text", "image"],
          "reasoning": true,
          "thinkingLevelMap": { "off": "none" },
          "contextWindow": 16384,
          "maxTokens": 4096
        }
      ]
    }
  }
}
```

- Set `input` to `["text", "image"]` only if the model has vision.
- Set `reasoning` to `true` only if the model can think. The think picker skips models without reasoning.
- Make `contextWindow` match the Ollama context length (`OLLAMA_CONTEXT_LENGTH`). A small `contextWindow` makes pi send a very small output limit.

## Commands

| Command | Action |
|---|---|
| `/fm <question>` | Ask a side question. |
| `/fm+ <question>` | Ask a side question about the current session. |
| `/fm-panel` or Ctrl+Shift+A | Open the fm side chat on the right. Press Esc to go back to the main chat. Press the shortcut again to hide the panel. Start a question with `+` to ask about the current session. The chat does not go into the main model's context. |
| `/fm-think off` | Turn the think picker off. `/fm-think on` turns it on again. |
| `/remember <fact>` | Add a fact to core memory. |
| `/memory` | Show the memory files and the text that apple-pi adds to the system prompt. |

## Think picker

1. You send a prompt.
2. The helper asks the Apple model if the prompt needs reasoning. This takes about 0.4 seconds.
3. If the answer is `no_think`, apple-pi sets thinking to `off` for this prompt.
4. If the answer is `think`, apple-pi sets thinking to your base level.

Your base level is the level that you set. If you change the level by hand, apple-pi uses your new level as the base level. If your base level is `off`, apple-pi does not change it. If the Apple model fails, apple-pi does not change the level.

## Memory

apple-pi keeps memory in `~/.apple-pi/memory/`. Set `APPLE_PI_MEMORY` to use a different folder.

| File | Content | Written by | When |
|---|---|---|---|
| `now.md` | One line for each finished task: the prompt, the tools, and the result. | Plain code | After each task |
| `today-YYYY-MM-DD.md` | One paragraph for each past day. | Apple Foundation Model | First session after that day |
| `recent.md` | The day paragraphs from the last 7 days. | Plain code | Same pass |
| `archive.md` | Day paragraphs older than 7 days, grouped by week. | Plain code | Same pass |
| `core.md` | Facts and preferences that you add. | You, with `/remember` | When you run the command |

At the start of a session, apple-pi adds `core.md`, the last 5 tasks from today, and `recent.md` to the system prompt. The limit is about 3,200 characters. The text does not change during the session, so the model can cache the prompt.

The Apple model writes only the day paragraphs. apple-pi checks each paragraph against the source notes. If a paragraph contains a path, number, or name that is not in the notes, apple-pi keeps the raw notes instead.

## Limits

- The Apple model has a context of 8,192 tokens. apple-pi cuts input to about 5,500 tokens.
- The Apple model runs one request at a time. On a local GPU model, a parallel Apple model request makes both slower. apple-pi runs the Apple model only before a prompt starts or after it ends.
- `ask_file` cannot count. Use `grep -c` to count lines.
- `ask_file` without a pattern reads the file in chunks. This takes about 1 minute for 165 KB. Give a pattern for large files. Files over 200 KB need a pattern.
- `translate` works only for language pairs that macOS has installed.
- Do not use `describe_image` for exact text, code, or IDs. The Apple model can change identifiers.

## Development

Run the tests:

```sh
node --test test/apple-pi.test.ts
```

Run pi with print mode. Send `/dev/null` to stdin, because pi waits for stdin in print mode:

```sh
pi -p -e ./apple-pi "your prompt" </dev/null
```
