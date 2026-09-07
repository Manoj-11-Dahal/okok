import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { runProjectCommand, type ProjectCommandResult } from './project-command-runner'
import { ownsFile, safePath } from './multi-ai/contracts'
import type { TaskContract } from '../shared/multi-ai'

export type ProviderToolCall = {
  id: string
  name: string
  arguments: string
}

export type ToolExecutionResult = {
  toolCallId: string
  name: string
  content: string
  changedFile?: string
  changedFiles?: string[]
  commandResult?: ProjectCommandResult
}

const ignored = new Set(['.git', 'node_modules', 'dist', 'out', 'build', '.next', 'target'])

export const codingToolDefinitions = [
  { type: 'function', function: { name: 'edit_file', description: 'Replace one exact, unique text segment in a file. Read the relevant range first; use small edits for large files.', parameters: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['path', 'old_text', 'new_text'], additionalProperties: false } } },
  { type: 'function', function: { name: 'append_file', description: 'Append a small text chunk to an existing owned file. Build large new files in bounded chunks instead of exceeding the response budget.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false } } },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files and directories inside the selected project. Use this before deciding what to edit.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Project-relative directory. Use an empty string for the project root.' } },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a UTF-8 text file inside the selected project.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Project-relative file path.' }, start_line: { type: 'integer', minimum: 1 }, end_line: { type: 'integer', minimum: 1 } },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or replace a UTF-8 text file inside the selected project. Parent directories are created automatically.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Project-relative file path.' },
          content: { type: 'string', description: 'Complete file content.' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run one development command in the selected project and return its real combined output and exit code. Use it to initialize projects, install dependencies, run builds and tests, and inspect failures. Commands are not executed through a general shell; pass every argument separately.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Allowed executable name such as pnpm, npm, npx, node, python, git, cargo, go, or dotnet.' },
          args: { type: 'array', items: { type: 'string' }, description: 'Arguments passed directly to the command.' },
          timeout_ms: { type: 'integer', minimum: 1000, maximum: 300000, description: 'Optional timeout. Defaults to 120000 ms.' },
        },
        required: ['command', 'args'],
        additionalProperties: false,
      },
    },
  },
] as const

function parseArguments(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value || '{}')
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error()
    return parsed as Record<string, unknown>
  } catch {
    throw new Error('Tool arguments were not valid JSON.')
  }
}

export class ProjectToolBroker {
  private readonly root: string
  private writes = 0
  private writtenBytes = 0
  private commands = 0
  private readonly signal: AbortSignal

  constructor(projectPath: string, signal: AbortSignal = new AbortController().signal, private readonly scope?: TaskContract) {
    this.root = realpathSync(projectPath)
    this.signal = signal
  }

  async execute(call: ProviderToolCall): Promise<ToolExecutionResult> {
    try {
      this.signal.throwIfAborted()
      const args = parseArguments(call.arguments)
      if (call.name === 'list_files') return this.listFiles(call.id, typeof args.path === 'string' ? args.path : '')
      if (call.name === 'read_file') return this.readFile(call.id, args.path, args.start_line, args.end_line)
      if (call.name === 'write_file') return this.writeFile(call.id, args.path, args.content)
      if (call.name === 'edit_file' || call.name === 'append_file') {
        const target = this.resolvePath(args.path)
        if (this.scope && !ownsFile(this.scope, target.relative)) throw new Error(`SCOPE VIOLATION: ${target.relative}`)
        if (statSync(target.absolute).size > 1_000_000) throw new Error('File exceeds the editing limit.')
        const before = readFileSync(target.absolute, 'utf8')
        let after: string
        if (call.name === 'append_file') { if (typeof args.content !== 'string') throw new Error('Text content is required.'); after = before + args.content }
        else { if (typeof args.old_text !== 'string' || !args.old_text || typeof args.new_text !== 'string' || !before.includes(args.old_text) || before.indexOf(args.old_text) !== before.lastIndexOf(args.old_text)) throw new Error('old_text must match exactly one nonempty segment; read the file again.'); after = before.replace(args.old_text, () => args.new_text as string) }
        return { ...this.writeFile(call.id, args.path, after), name: call.name }
      }
      if (call.name === 'run_command') { if (this.scope) throw new Error('Worker commands must be requested through the Director for verification. Direct command execution is outside the worker file scope.'); return await this.runCommand(call.id, args.command, args.args, args.timeout_ms) }
      throw new Error(`Unknown tool: ${call.name}`)
    } catch (error) {
      return {
        toolCallId: call.id,
        name: call.name,
        content: `ERROR: ${error instanceof Error ? error.message : 'Tool execution failed.'}`,
      }
    }
  }

  private snapshotFiles(): Map<string, string> {
    const snapshot = new Map<string, string>()
    const visit = (directory: string): void => {
      if (snapshot.size >= 20_000) return
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (ignored.has(entry.name) || entry.isSymbolicLink()) continue
        const absolute = resolve(directory, entry.name)
        if (entry.isDirectory()) visit(absolute)
        else if (entry.isFile()) {
          const metadata = statSync(absolute)
          snapshot.set(relative(this.root, absolute).replaceAll('\\', '/'), `${metadata.size}:${metadata.mtimeMs}`)
        }
      }
    }
    visit(this.root)
    return snapshot
  }

  private async runCommand(toolCallId: string, command: unknown, args: unknown, timeout: unknown): Promise<ToolExecutionResult> {
    if (typeof command !== 'string' || !Array.isArray(args) || args.some((argument) => typeof argument !== 'string')) {
      throw new Error('run_command requires a command and an array of string arguments.')
    }
    if (this.commands >= 15) throw new Error('Task command limit exceeded.')
    const timeoutMs = typeof timeout === 'number' && Number.isInteger(timeout) ? Math.min(300_000, Math.max(1_000, timeout)) : 120_000
    const before = this.snapshotFiles()
    this.commands += 1
    const result = await runProjectCommand({ projectRoot: this.root, command, args: args as string[], timeoutMs, signal: this.signal })
    const after = this.snapshotFiles()
    const changedFiles = [...new Set([
      ...[...after].filter(([path, fingerprint]) => before.get(path) !== fingerprint).map(([path]) => path),
      ...[...before.keys()].filter((path) => !after.has(path)),
    ])].slice(0, 250)
    const status = result.timedOut ? 'timed out' : `exited with code ${result.exitCode ?? 'unknown'}`
    const compactOutput = this.compactCommandOutput(result.output)
    return {
      toolCallId,
      name: 'run_command',
      content: `Command ${status}: ${result.command}\n\n${compactOutput}`,
      changedFiles,
      commandResult: result,
    }
  }

  private compactCommandOutput(output: string): string {
    if (output.length <= 12_000) return output
    const lines = output.split(/\r?\n/), selected = new Set<number>()
    for (let index = 0; index < Math.min(20, lines.length); index++) selected.add(index)
    for (let index = Math.max(0, lines.length - 80); index < lines.length; index++) selected.add(index)
    for (let index = 0; index < lines.length; index++) if (/error|failed|failure|exception|traceback|fatal|warning|cannot|undefined|not found/i.test(lines[index]!)) for (let nearby = Math.max(0, index - 2); nearby <= Math.min(lines.length - 1, index + 2); nearby++) selected.add(nearby)
    const sorted = [...selected].sort((a, b) => a - b), result: string[] = [`[Compacted ${output.length} characters / ${lines.length} lines. Full output retained in the command result.]`]
    let previous = -2
    for (const index of sorted) { if (index > previous + 1) result.push('…'); result.push(`${index + 1}: ${lines[index]}`); previous = index; if (result.join('\n').length > 11_500) break }
    return result.join('\n').slice(0, 12_000)
  }

  private resolvePath(input: unknown, allowRoot = false): { absolute: string; relative: string } {
    if (typeof input !== 'string') throw new Error('A project-relative path is required.')
    const normalizedInput = input.trim().replaceAll('\\', '/')
    if ((!allowRoot && normalizedInput.length === 0) || isAbsolute(normalizedInput) || normalizedInput.includes('\0')) {
      throw new Error('The path must be relative to the selected project.')
    }
    const absolute = resolve(this.root, normalizedInput || '.')
    const projectRelative = relative(this.root, absolute)
    if (projectRelative === '..' || projectRelative.startsWith(`..${sep}`) || isAbsolute(projectRelative)) {
      throw new Error('Path traversal outside the selected project was blocked.')
    }
    if (projectRelative) safePath(projectRelative.replaceAll('\\', '/'))

    let cursor = this.root
    for (const segment of projectRelative.split(sep).slice(0, -1)) {
      cursor = resolve(cursor, segment)
      if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error('Symbolic-link traversal was blocked.')
    }
    if (existsSync(absolute) && lstatSync(absolute).isSymbolicLink()) throw new Error('Symbolic-link access was blocked.')
    return { absolute, relative: projectRelative.replaceAll('\\', '/') }
  }

  private listFiles(toolCallId: string, path: string): ToolExecutionResult {
    const target = this.resolvePath(path, true)
    if (!existsSync(target.absolute) || !lstatSync(target.absolute).isDirectory()) throw new Error('Directory not found.')
    const entries = readdirSync(target.absolute, { withFileTypes: true })
      .filter((entry) => !ignored.has(entry.name) && !entry.isSymbolicLink())
      .slice(0, 250)
      .map((entry) => `${entry.name}${entry.isDirectory() ? '/' : ''}`)
    return { toolCallId, name: 'list_files', content: entries.length > 0 ? entries.join('\n') : '(empty directory)' }
  }

  private readFile(toolCallId: string, path: unknown, start?: unknown, end?: unknown): ToolExecutionResult {
    const target = this.resolvePath(path)
    if (!existsSync(target.absolute) || !lstatSync(target.absolute).isFile()) throw new Error('File not found.')
    if (statSync(target.absolute).size > 2_000_000) throw new Error('File exceeds the 2 MB source retrieval limit.')
    const text = readFileSync(target.absolute, 'utf8')
    if (text.includes('\0')) throw new Error('Binary files cannot be sent as source context.')
    const lines = text.split('\n')
    const first = typeof start === 'number' && Number.isInteger(start) ? Math.max(1, start) : 1
    const last = typeof end === 'number' && Number.isInteger(end) ? Math.min(first + 299, end) : first + 299
    const content = lines.slice(first - 1, last).map((line, index) => `${first + index}: ${line}`).join('\n').slice(0, 24000)
    return { toolCallId, name: 'read_file', content: `${target.relative} (${lines.length} lines; requested ${first}–${Math.min(last, lines.length)})\n${content}` }
  }

  private writeFile(toolCallId: string, path: unknown, content: unknown): ToolExecutionResult {
    if (typeof content !== 'string') throw new Error('File content must be text.')
    if (content.length > 1_000_000) throw new Error('A single file cannot exceed 1 MB.')
    if (this.writes >= 40 || this.writtenBytes + content.length > 5_000_000) throw new Error('Task write limit exceeded.')
    const target = this.resolvePath(path)
    if (this.scope && !ownsFile(this.scope, target.relative)) throw new Error(`SCOPE VIOLATION: ${target.relative} is not owned by ${this.scope.id}. Request the dependency through the Director.`)
    if (existsSync(target.absolute) && readFileSync(target.absolute, 'utf8') === content) return { toolCallId, name: 'write_file', content: `No change: ${target.relative} already has the requested content.` }
    mkdirSync(resolve(target.absolute, '..'), { recursive: true })
    writeFileSync(target.absolute, content, 'utf8')
    this.writes += 1
    this.writtenBytes += content.length
    return { toolCallId, name: 'write_file', content: `Wrote ${target.relative} (${content.length} characters).`, changedFile: target.relative }
  }
}
