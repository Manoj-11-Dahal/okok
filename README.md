# ALTREX CODE

ALTREX CODE is a local-first desktop AI coding environment. **Agent** mode can use the real Codex App Server or a connected tool-capable OpenAI-compatible model, including NVIDIA NIM. **Ask** mode uses the connected provider for read-only questions. Large local models are optional and are not required.

The current executable includes the ALTREX shell, persistent recent project and conversation state, OS-encrypted provider connections, bounded repository context, streaming responses, cancellation, and autonomous workspace tools. Agent mode is rooted in the selected folder and can create project files and folders, install dependencies, run builds/tests, inspect failures, and keep iterating. Workspace writes remain sandboxed to the selected folder. OpenAI, NVIDIA NIM, OpenRouter, Groq, and custom OpenAI-compatible endpoints are supported.

## Start the desktop app

For a shareable Windows installer and portable EXE, run `pnpm dist:win`. The files are written to `release/`. See [Windows distribution](docs/WINDOWS_RELEASE.md) for subscriber setup and release verification.

```powershell
pnpm install
pnpm dev
```

For renderer-only development and visual testing:

```powershell
pnpm dev:web
```

Validation:

```powershell
pnpm typecheck
pnpm test
pnpm build
```

## Use Codex Agent

1. Install/sign in to the OpenAI Codex desktop app, then restart ALTREX so it can detect the bundled Codex runtime.
2. Start ALTREX with `pnpm dev`.
3. Choose **Open project** and select the folder Codex should own.
4. Select **Agent**, describe the software or change, and send the task.

Agent activity, real command results, and the files actually changed are shown in the conversation. ALTREX automatically prefers the newer Codex runtime bundled with the desktop app and falls back to a global Codex CLI when necessary. The selected folder is the Codex workspace root; access requests outside it are denied.

Use **Ask** for read-only questions. Ask mode is separate: choose **Connect AI**, select a provider, enter its API key and model ID, test the connection, then connect. The key is encrypted through Electron `safeStorage` and is never stored in the repository or renderer persistence.

## Use NVIDIA NIM

1. Create an NVIDIA API key from the [NVIDIA API Catalog](https://build.nvidia.com/explore/discover).
2. In ALTREX, choose **Connect AI** and then **NVIDIA NIM**.
3. Paste the key, choose a default coding model, run **Test connection**, and connect.
4. In the task composer choose **Agent** and **AUTO · Best for task**. AUTO ranks the coding and tool-capable models currently exposed by NVIDIA NIM or Groq for the specific task. If the first model times out, is rate-limited, rejects tool calling, returns no usable result, or is temporarily unavailable, ALTREX keeps the task context and visibly switches through up to three additional ranked models. You can also choose any discovered model manually; manual selection disables automatic model switching.

The NVIDIA connection uses the OpenAI-compatible `https://integrate.api.nvidia.com/v1` endpoint. A connected tool-capable model receives ALTREX's bounded workspace tools, so it can edit files and run development commands instead of acting only as a chat bot.

## Attach images and files

Use the paperclip or **Add context** button in the composer to select up to eight files, with a 20 MB limit per file. Images display a removable thumbnail and are sent as multimodal image input to compatible NVIDIA, Groq, OpenAI-compatible, or Codex models. Text, source code, Markdown, JSON, CSV, configuration, and similar readable files are included directly as bounded model context.

When a project is open, ALTREX also creates a workspace copy beneath `.altrex/attachments/`. This lets autonomous agents inspect PDFs, Office documents, archives, spreadsheets, and other binary formats with their normal project tools. AUTO considers image attachments when ranking vision-capable coding models. Attachment previews and file contents are not persisted in browser local storage.

Remote endpoints must use HTTPS. Plain HTTP is accepted only for `localhost`, `127.0.0.1`, or `::1` custom endpoints.

The product contracts and staged delivery plan live in [`docs/`](docs/).
