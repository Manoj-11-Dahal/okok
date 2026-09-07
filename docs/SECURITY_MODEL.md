# ALTREX CODE Security Model

Implementation note (September 2026): sections below include the broader security design, not a claim that every planned approval/profile/plugin service is implemented. Current provider, broker, isolated-copy, command-permission and publication boundaries are documented in [Multi-AI implementation](MULTI_AI_IMPLEMENTATION.md). In particular, connected-provider commands retain OS permissions; source copies are not an OS sandbox.

## Security objectives

1. Repository content leaves the machine only through an explicitly allowed model/provider route.
2. A renderer compromise cannot directly access Node.js, files, terminals, credentials, or arbitrary IPC.
3. Agents receive least privilege and cannot broaden their own permissions.
4. Material changes are attributable, reviewable, cancellable, and recoverable.
5. Secrets are never persisted in project files or observability payloads.

## Trust boundaries

The Electron renderer, repository contents, model output, MCP responses, websites, plugins, skills, terminal output, and downloaded dependencies are untrusted inputs. Electron main, the orchestrator, and policy engine are privileged but mutually constrained through typed interfaces. Provider APIs and local model servers are external systems even when bound to localhost.

## Permission profiles

Profiles are composed from capabilities plus scoped constraints:

| Profile | Default capabilities |
|---|---|
| Read only | read project files, search, inspect Git metadata |
| Edit project | read/write inside project through patch service |
| Run safe commands | edit plus allowlisted non-privileged processes |
| Full project access | all project-scoped file/process/Git operations except always-ask actions |
| Custom | explicit capability and constraint set |

Capabilities include `fs.read`, `fs.write`, `fs.delete`, `process.execute`, `process.network`, `git.read`, `git.write`, `git.destructive`, `credential.use`, `browser.inspect`, `mcp.call`, `plugin.load`, and `system.modify`.

Rules constrain canonical roots, executable and argument patterns, network hosts/ports, duration, byte count, process count, provider privacy class, and expiry. Deny overrides allow. The broker evaluates the requested operation, resolves symlinks/canonical paths, obtains approval if needed, and revalidates immediately before execution to reduce time-of-check/time-of-use risk.

## Always-ask operations

Unless a user has created a specific persistent rule, approval is required for filesystem access outside the selected project, credential access, network egress, dependency installation, privileged commands, system configuration, destructive Git operations, deletion of untracked material, publishing/deployment, external messages, and use of repository data with a new cloud provider.

Approval UI shows actor, exact capability, canonical target, sanitized command/request, reason, duration, and proposed scope (`once`, `task`, or named persistent rule). Approval cannot be requested using model-authored hidden text.

## Electron hardening

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`.
- A narrow preload bridge with one method per validated IPC operation.
- Navigation, popups, permissions, downloads, and external URL opening denied by default.
- Production renderer is loaded from packaged local assets with a restrictive CSP.
- No remote code execution, `eval`, or dynamic plugin code in the renderer.
- IPC handlers validate payload schemas and sender origin.

## Tool and workspace isolation

Parallel writers receive distinct Git worktrees, containers, or temporary clones. Workspace leases bind worker ID, canonical root, Git base, expiry, and allowed operations. The integration worker applies reviewed patches to an integration worktree. The primary user checkout is not a shared scratch area.

Terminal execution uses explicit executable/argument arrays and a controlled environment. It strips secret-bearing environment variables unless granted, limits output and runtime, owns the process tree, and guarantees cancellation cleanup.

## Secret handling

The current desktop implementation encrypts provider credentials in Electron main with `safeStorage` before writing ciphertext beneath Electron's user-data directory. On Windows this is protected with DPAPI; insecure Linux `basic_text` storage is rejected. The renderer holds a key only in transient password-input state and never writes it to local storage, project files, IPC logs, or source. Provider responses are redacted if they echo the submitted key. A later credential service may replace the encrypted file with opaque native keychain references without changing the renderer API.

## Prompt-injection resistance

Repository text, web pages, MCP content, issues, and tool output are labeled untrusted data. They cannot modify system policy or approval state. Model output requests capabilities through structured tool calls; the policy engine decides. Retrieval provenance is preserved so agents and users can identify instructions that originated inside repository content.

## Supply chain and plugins

Dependencies use lockfiles and automated auditing. Plugins declare publisher, version, entry points, requested capabilities, network hosts, and integrity hashes. Install and capability grants are separate approvals. Plugins execute outside the renderer in constrained hosts and cannot access another project's data by default.

## Checkpoints and undo

Before material edits, ALTREX records the working-tree state, Git base, patch manifest, and untracked file inventory. Restore previews destructive impact and never relies on broad hard reset. Checkpoints and worktrees have retention policies; cleanup resolves and verifies exact paths before deletion.

## Audit and incident response

The append-only action log records actor, task, worker, capability, sanitized input, policy decision, outcome, and time. Users can export logs and revoke persistent grants. Repeated provider failures or suspicious tool denials trip a circuit breaker, pause affected workers, and surface a specific recovery action.

## Security verification

Required tests cover path traversal, symlink escape, malformed IPC, renderer origin, command injection, environment leakage, approval replay, expired grants, cancellation cleanup, cross-workspace access, cloud consent, log redaction, malicious MCP output, plugin capability escalation, and checkpoint restore safety.
