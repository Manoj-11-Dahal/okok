import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'

const ignoredDirectories = new Set([
  '.git', '.next', '.turbo', '.venv', '.altrex', '.pnpm-store', 'build', 'coverage', 'dist', 'node_modules', 'out', 'target',
])
const contextFileNames = new Set([
  'ALTREX.md', 'Cargo.toml', 'go.mod', 'package.json', 'pyproject.toml', 'README.md', 'README.txt',
  'tsconfig.json',
])

function collectTree(root: string, directory: string, depth: number, entries: string[]): void {
  if (depth > 4 || entries.length >= 400) return

  let children: string[]
  try {
    children = readdirSync(directory).sort((left, right) => left.localeCompare(right))
  } catch {
    return
  }

  for (const child of children) {
    if (entries.length >= 400 || ignoredDirectories.has(child)) continue
    const absolutePath = join(directory, child)
    let stat
    try {
      stat = lstatSync(absolutePath)
    } catch {
      continue
    }
    if (stat.isSymbolicLink()) continue
    const projectRelativePath = relative(root, absolutePath).replaceAll('\\', '/')
    entries.push(stat.isDirectory() ? `${projectRelativePath}/` : projectRelativePath)
    if (stat.isDirectory()) collectTree(root, absolutePath, depth + 1, entries)
  }
}

export function buildRepositoryContext(projectPath: string, task = '', maxCharacters = 16000): string {
  const tree: string[] = []
  collectTree(projectPath, projectPath, 0, tree)

  const contextSections: string[] = []
  let remainingCharacters = maxCharacters
  const terms = [...new Set(task.toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) ?? [])].filter(term => !['this', 'that', 'with', 'from', 'file', 'files', 'project', 'create', 'implement', 'should', 'using', 'task', 'code'].includes(term)).slice(0, 30)
  const cache = new Map<string, string>(), scores = new Map<string, number>()
  for (const entry of tree.filter(path => !path.endsWith('/') && /\.(tsx?|jsx?|py|go|rs|css|html)$/.test(path)).slice(0, 200)) {
    if (/\.env|secret|credential/i.test(entry)) continue
    try { if (lstatSync(join(projectPath, entry)).size > 200000) continue; const text = readFileSync(join(projectPath, entry), 'utf8'); if (text.includes('\0')) continue; cache.set(entry, text); scores.set(entry, terms.reduce((score, term) => score + (entry.toLowerCase().includes(term) ? 4 : text.slice(0, 20000).toLowerCase().includes(term) ? 1 : 0), 0)) } catch { /* Unreadable source is omitted. */ }
  }
  // Follow relative imports from the best matches so callers see real interfaces.
  for (const [entry, score] of [...scores].sort((a, b) => b[1] - a[1]).slice(0, 4)) {
    if (!score) continue
    for (const match of (cache.get(entry) ?? '').matchAll(/(?:from\s*|require\(\s*|import\(\s*)['"](\.[^'"]+)['"]/g)) {
      const base = relative(projectPath, resolve(projectPath, dirname(entry), match[1]!)).replaceAll('\\', '/')
      for (const candidate of [base, ...['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx'].map(extension => `${base}${extension}`)]) if (cache.has(candidate)) scores.set(candidate, Math.max(scores.get(candidate) ?? 0, 3))
    }
  }
  const relevance = (path: string) => scores.get(path) ?? terms.reduce((score, term) => score + (path.toLowerCase().includes(term) ? 2 : 0), 0)
  for (const entry of [...tree].sort((a, b) => relevance(b) - relevance(a))) {
    if (entry.endsWith('/')) continue
    const fileName = basename(entry)
    if (/\.env|secret|credential|\.pem$|\.key$|lock\.yaml|package-lock|yarn.lock/i.test(fileName)) continue
    if (!contextFileNames.has(fileName) && !fileName.startsWith('README') && (!relevance(entry) || !/\.(tsx?|jsx?|py|go|rs|css|html|json|md)$/.test(entry))) continue
    if (remainingCharacters <= 0) break

    try {
      if (lstatSync(join(projectPath, entry)).size > 2000000) continue
      const raw = cache.get(entry) ?? readFileSync(join(projectPath, entry), 'utf8')
      if (raw.includes('\0')) continue
      const lines = raw.split('\n')
      const matching = lines.flatMap((line, index) => terms.some(term => line.toLowerCase().includes(term)) ? [index] : [])
      const selected = raw.length > 5000 && matching.length ? [...new Set([0, ...matching.slice(0, 8)])].map(index => lines.slice(Math.max(0, index - 3), index + 18).map((line, offset) => `${Math.max(0, index - 3) + offset + 1}: ${line}`).join('\n')).join('\n…\n') : raw
      const content = selected.slice(0, Math.min(5000, remainingCharacters))
      remainingCharacters -= content.length
      contextSections.push(`--- ${entry} ---\n${content}`)
    } catch {
      // Ignore unreadable or non-text project metadata.
    }
  }

  return [
    `Project: ${basename(projectPath)}`,
    `Repository tree (bounded to ${tree.length} entries):\n${tree.join('\n')}`,
    contextSections.length > 0 ? `Selected project files:\n${contextSections.join('\n\n')}` : '',
  ].filter(Boolean).join('\n\n')
}
