# dsh-memory-curator

Curated durable memory for [DeepSeek Harness](https://github.com/deepseek-ai/dsh): automatic
capture of decisions, corrections, prohibitions and open work; progressive-disclosure recall;
duplicate consolidation; and old-vs-new conflict resolution. Everything is local — one JSON
store under `$DSH_HOME`, no network of its own, no account, no API key. Model calls reuse the
Harness `llm` service, so memory inherits the user's provider, credentials and retry policy.

[中文说明](#中文说明)

## Install

A plain Cordis bundle: no build step, no runtime dependencies.

```bash
# 1. install it into the profile that runs your DSH
cd "${DSH_HOME:-$HOME/.dsh}/profiles/desktop"    # your own profile directory
pnpm add link:/path/to/dsh-memory-curator

# 2. list it as a bundle in that profile's package.json, e.g.
#    "dsh": { "profile": { "bundles": [
#      "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-memory-curator" ] } }
```

Restart DSH. The host half mounts capture, recall, curation and the six `memory_*`
tools; the browser half adds the **Memory** entry to the left sidebar. The package ships
`cordis.patch.yml` — the patch DSH applies while composing the tree — so the plugin row
and its default configuration come from the package itself.

DSH's plugin manager (Settings → Plugins) accepts the same `link:` spec and performs both
steps for you; a page refresh is enough after that, no rebuild.

## What it does

| | Behaviour | How |
|---|---|---|
| **A. Auto-capture** | When a turn ends, the conversation is distilled into durable entries worth keeping across sessions: designated technical references, architecture decisions, explicit corrections, prohibitions, and unfinished work. | A fire-and-forget listener on `session/event` (`turn/end`) sends the new messages to one bounded auxiliary LLM call; the validated candidates are persisted. Memory work can never delay or fail a turn. |
| **B. Progressive recall** | Each turn gets a bounded one-line-per-entry index: the entries that change behaviour (decisions, corrections, prohibitions, open work) come first, then the most recent facts. Full text is fetched only on demand. | A resident catalog is injected into the system prompt (tier 0). `memory_search` returns short digests with ids (tier 1). `memory_detail` returns the complete entry (tier 2) and records the read, which feeds the ordering and the decay pass. The standing prompt cost stays flat as the store grows. |
| **C. Curation** | Duplicate knowledge folds into one entry; a newer decision on the same subject retires the outdated one. | A deterministic pass runs on every insert and periodically: same-subject decisional entries conflict, the newer wins, the older is kept as history with a `supersededBy` pointer. A model-assisted pass adjudicates the similar-subject pairs the deterministic pass cannot settle, biased toward `coexist` so a true memory is never wrongly retired. |

## What memory does not record

The plugin deliberately does not overlap with the artifacts a project already keeps. Any one
of these tests means *record nothing*:

| Test | Where that information belongs instead |
|---|---|
| Would a future session get it from the repository? Architecture, file paths, build and test commands, dependency lists, directory layout, git history. | The code and git themselves. |
| Is it a project-level instruction — a convention, an "always/never" rule? | `AGENTS.md` / `CLAUDE.md`, where every teammate and every tool sees it. Memory is machine-local and invisible to the rest of the team. |
| Is it task state — progress, next steps, a worked-off plan? | `STATE.md`, a todo list, or the issue tracker. |
| Is it a report that something was just done? "published the repository", "rewrote the history", "added a section". | The artifact is its own record. |

To make the first two decidable rather than a matter of taste, every distillation call carries
the repository context: the bounded text of `AGENTS.md` / `CLAUDE.md` when they exist, plus the
names of `README.md`, `STATE.md`, `TODO.md`, `CONTRIBUTING.md`, `ARCHITECTURE.md`,
`CHANGELOG.md` and `docs/`. Reads are cached by mtime and size, so a quiet repository costs a
few `stat` calls per turn.

What is left is the part with no other home: environment and tooling traps, the user's own
preferences and corrections, and facts about this machine that the repository cannot know.

Because memory is machine-local, the agent is also told — in the resident recall guidance — to
**promote** an entry that is really a project rule into `AGENTS.md` / `CLAUDE.md` and then
`memory_forget` it, so the two cannot drift apart.

## Measuring recall

The plugin records what memory is *used*, not only what it stores: `memory_detail`
marks the entry it opened (`recallCount`, `lastRecalledAt`), the panel shows that
count per entry and the store-wide total in its header, and an entry that was
just read counts as fresh when the index is ordered — being used is not punished
by age.

`npm run audit:recall` reads DSH's own session logs (the plugin records no recall
events) and reports what actually happened: which memory tools the agent reached
for, how many entries it opened in full, how often the index had to hide entries,
and which entries are hidden right now. It is read-only, and it decodes a session
log frame by frame, because DSH writes one zstd frame per record.

A run over the first ~7 hours of real use:

```text
tool calls     memory_add=16  memory_detail=13  memory_forget=10  memory_stats=4
               memory_search=0  memory_curate=0
readership     9 of 55 active entries ever opened in full
index          166 injections, 26% of them had to hide entries
eviction       13 of 52 visible entries hidden — 5 decisional, 6 of them read
```

That measurement drove two decisions: the index is now layered (rules and
decisions first, then the most recent facts) because a purely newest-first index
let fresh task narration evict the platform knowledge that had actually been
read, including a live prohibition; and the footer now names `memory_search`
instead of only counting what was withheld.

**Subagents get the tools but not the resident index.** DSH marks a delegated
session in its header (`origin: 'subagent'`, `delegationDepth`), and over three
subagent sessions each one received a full catalog while the three together made
a single memory call. They can still search on demand.

## Required permission

**`Read Only` (仅可查看) is sufficient for full functionality.**

The four session permission modes — `Read Only` (仅可查看), `Workspace Write` (工作区内修改),
`Full access` (完全权限), and `Auto review` — gate the **agent's built-in tools**, not plugin
host code:

- **File tools** (`read`/`write`/`edit`/`glob`/`grep`) are fenced by `dsh-fs-sandbox`, the
  sandboxed `ctx.fs` provider. Its own README states it "restricts **the model's** file writes
  and edits" and that the fence "is a policy check of the **model-controlled path** in trusted
  code, not a kernel boundary." It is applied inside the file-tool layer, not as a global
  `fs` interception.
- **Shell tools** (`bash`/`pwsh`) are confined by `dsh-bash-sandbox`/`dsh-pwsh-sandbox` as a
  subprocess. Plugin code runs in the host process, not in a confined subprocess.
- **`Auto review`** reviews native tool calls; it does not fence plugin host code.

This plugin does its own persistence with `node:fs` directly (not through the sandboxed `ctx.fs`
seam), calls the `llm` service (not a file/shell operation), and registers its own tools
(`memory_search`, `memory_detail`, `memory_add`, `memory_curate`, `memory_forget`,
`memory_stats`) whose `execute` runs as host code. None of these paths cross the file or shell
sandbox, so the session permission mode does not restrict them. The store lives under
`$DSH_HOME/memory-curator/store.json` (outside the workspace), and writes there succeed under
every mode — including `Read Only`.

> The approval policy (`ask` under Read Only / Workspace Write, `never` under Full access) only
> governs **escalation** requests (a tool retrying with a wider sandbox mode). This plugin's
> tools carry no `sandbox_permissions` and never escalate, so `ask` never interrupts them.

| Mode | Capture | Recall | Curation | Custom tools | Verdict |
|---|---|---|---|---|---|
| Read Only (仅可查看) | ✅ | ✅ | ✅ | ✅ | **Full functionality** |
| Workspace Write (工作区内修改) | ✅ | ✅ | ✅ | ✅ | Full functionality |
| Full access (完全权限) | ✅ | ✅ | ✅ | ✅ | Full functionality |
| Auto review | ✅ | ✅ | ✅ | ✅ | Full functionality (experimental host) |

## Configuration

All settings are optional; the bundle patch ships sensible defaults.

| Key | Default | Meaning |
|---|---|---|
| `captureEnabled` | `true` | Distil finished turns into durable entries. |
| `recallEnabled` | `true` | Inject the resident catalog each turn. |
| `curateEnabled` | `true` | Fold duplicates and retire superseded entries. |
| `catalogMaxBytes` | `2400` | Byte budget for the injected index. |
| `curateEveryTurns` | `5` | Run the model-assisted conflict pass every N turns. |
| `maxConcurrentDistills` | `2` | Cap simultaneous distillation calls. |
| `distillTimeoutMs` | `60000` | Per-call deadline for distillation/adjudication. |
| `minTurnChars` | `80` | Transcripts shorter than this are not worth a model call. |
| `dupThreshold` | `0.82` | Jaccard overlap above which two entries are duplicates. |
| `storeFile` | `$DSH_HOME/memory-curator/store.json` | Store location. |

## Tools

| Tool | Tier | Purpose |
|---|---|---|
| `memory_search` | 1 (digest) | Search active memory by free text; returns short digests with ids. |
| `memory_detail` | 2 (full) | Read one entry in full by id or unambiguous prefix. |
| `memory_add` | write | Record one durable entry; duplicates fold, same-subject decisions supersede. |
| `memory_curate` | write | Run the curation pass now (fold + retire + adjudicate). |
| `memory_forget` | write | Retire one entry from recall (soft; kept as history). |
| `memory_stats` | read | Counters: active, superseded, merged, forgotten, per-kind. |

> **Tool schemas are object-rooted JSON Schema.** `ctx.tools.register()` forwards a tool's
> `parameters` to the model provider **verbatim** — it compiles nothing — so a bare property map
> (`{ text: { type: 'string', required: true } }`) arrives without a root `type` and the provider
> rejects the *entire request*:
>
> ```
> Invalid schema for function 'memory_add': schema must be a JSON Schema of type: "object",
> got type: "null". (INVALID_REQUEST)
> ```
>
> `toolDefinition` in `lib/harness.js` therefore compiles the authoring shorthand into
> `{ type: 'object', properties, required? }` with the same rules as the Harness's own
> `defineTool`, and `assertParameters` fails the registration outright if the result is not
> object-rooted. `test/tools.test.js` cross-checks every spec against the Harness's real
> compiler when `@deepseek-ai/dsh-tools` is installed, so the two cannot drift.


## Management panel (sidebar)

A browser half (`lib/client.js`) adds a **Memory** button to the DSH left sidebar.
Clicking it opens a central panel that talks to the host over the plugin's own
same-origin HTTP routes:

| Panel action | Route | Effect |
|---|---|---|
| List + filter | `GET /api/memory-curator/entries` | All entries (every scope and status), newest first. |
| Search | `GET /api/memory-curator/search?q=` | Server-side keyword search over active entries. |
| Expand a row | `GET /api/memory-curator/detail?id=` | Full text, id, scope, successor. |
| Add memory | `POST /api/memory-curator/add` | Record one entry (defaults to the `global` scope). |
| Forget | `POST /api/memory-curator/forget` | Retire an entry from recall. |
| Curate | `POST /api/memory-curator/curate` | Run the deterministic fold + retire pass now. |

The panel inherits the shell's theme through the real `--dsw-alias-*` tokens and
needs no build step — it is plain `React.createElement` loaded through
`window.__ModuleLoader__`. The routes are mounted by `lib/panel-api.js` onto the
composition's `webServer` service inside a nested `ctx.inject` fiber, so a
composition without a web server loses only the panel, never capture or recall.

> **Why HTTP and not `ctx.remote.memoryCurator`?** A browser half that declares a
> hard dependency on a Remote namespace (`inject: ['remote.<ns>']`) stays
> `pending` when that namespace never appears, and the DSH web shell reports a
> pending client entry as a **boot failure** — `web boot: 1 entry did not
> activate` — which stops the whole app from starting. Same-origin routes carry
> no such coupling: if the backend is missing the panel shows an ordinary,
> recoverable error instead. This mirrors the pattern used by the known-good
> `dsh-our-free-model` bundle.

## Entry kinds

`decision` · `correction` · `prohibition` · `reference` · `open` · `fact`

`decision`, `correction` and `prohibition` are *decisional*: within one scope and subject, a
newer one supersedes the older. The others consolidate by subject without retiring.

## Storage and scope

- One JSON document, written atomically (temp file + rename), mode `0600`. A corrupt store is
  quarantined to `store.json.corrupt-<ts>` rather than crashing the profile.
- Entries are scoped per workspace (a SHA-1 prefix of the session `cwd`); a `global` scope is
  visible to every workspace. Recall sees the current scope plus global.
- Hard caps: 5000 entries (retired history is dropped first), 1200 chars per text, 200 per
  subject, 12 tags.

## Architecture

```
lib/index.js     — Cordis Service (TypertRemoteService) + Config; delegates to mount()
lib/mount.js     — mount(): capture wiring, recall injection, tool registration, panel API
lib/tools.js     — the six tool specs: authoring parameter map + handlers (single source of truth)
lib/panel-api.js — /api/memory-curator/* HTTP surface for the sidebar panel
lib/client.js    — browser half: sidebar entry + management panel (React, same-origin fetch)
lib/harness.js   — Harness glue with zero install-time deps (plain ctx.tools/ctx.llm contracts,
                   plus the parameter-spec → object-rooted JSON Schema compiler)
lib/store.js     — MemoryStore: insert/fold/conflict/curate/search/forget + atomic persistence
lib/extract.js   — distillTurn (A) and resolveConflict (C, model-assisted)
lib/parse.js     — pure prompts, JSON extraction, entry validation, transcript rendering
lib/recall.js    — catalog/digest/detail rendering with byte budgets
```

No build step. The host half declares `@deepseek-ai/cordis` and
`@deepseek-ai/schemastery` as peer dependencies (provided by the Harness runtime);
the browser half needs only `react` (supplied by the client module loader).

`@deepseek-ai/dsh-tools` is a **development-only** dependency for
`npm test`: the schema contract tests compare this plugin's compiler and schemas
against the Harness's real `parameterSchemaSpecToJsonSchema` /
`assertSupportedJsonSchema`. They skip themselves when it is absent, so the
plugin still runs and tests from a bare checkout with no dev install.

Inside a sandboxed DSH shell, plain `npm test` fails with `spawn EPERM`: Node's
test runner starts one child process per test file and captures its output over a
pipe, which the sandbox does not allow. `npm run test:in-process` runs the same
suite in a single process instead.

## 中文说明

为 DeepSeek Harness 提供策展式持久记忆。

- **A. 自动记录**：每轮对话结束后，将值得跨会话保留的信息（指定的技术参考、架构决定、明确纠错、禁止事项、未完成状态）蒸馏为持久条目。后台监听 `turn/end`，fire-and-forget，绝不拖慢或拖垮对话。
- **B. 自动召回**：每轮注入一行一条的有界索引；`memory_search` 返回短摘要与 id；`memory_detail` 按需读取全文。常驻提示成本随库增长保持平坦。
- **C. 自动整理**：重复知识按 Jaccard 相似度合并；同主题的新旧决策冲突时新者胜出、旧者标记 `superseded` 并保留 `supersededBy` 指针；确定性规则无法裁决的相似主题对由一次有界模型调用裁决，偏向 `coexist` 以免误退真记忆。
- **D. 管理面板**：DSH 左侧边栏新增 **Memory** 入口按钮，点击打开中央面板，通过插件自己的同源 HTTP 路由 `/api/memory-curator/*` 列出/筛选/新增/遗忘/整理全部记忆条目。无需构建步骤，纯 `React.createElement`。

  > **为什么用 HTTP 而不是 `ctx.remote.memoryCurator`？** 浏览器半若把 Remote 命名空间声明为硬依赖（`inject: ['remote.<ns>']`），而该命名空间始终不出现，该条目会一直 `pending`；DSH 网页外壳把 pending 的客户端条目判定为**启动失败**（`web boot: 1 entry did not activate`），导致整个应用无法启动。同源路由没有这种耦合：后端缺失时面板只显示一个可恢复的错误。此做法与已知可用的 `dsh-our-free-model` 插件一致。

- **同源护栏**：这些路由注册在 DSH 的 web server 上，而插件前缀在该 server 的鉴权闸门**之前**分发——同一端口上 DSH 自带的 `/api/client-modules` 无凭据返回 401，本插件的路由却返回 200（已在 127.0.0.1:19387 实测）。因此处理器自己校验浏览器给出的跨站标记：`Sec-Fetch-Site` 不是 `same-origin`/`none`，或 `Origin` 的主机与本次请求的 `Host` 不一致，一律 403。会带这两个头的是浏览器；两者都没有的请求来自本地进程（脚本、curl、测试），不具浏览器的环境权限，照常放行，所以命令行调用不受影响。

- **与仓库文档的边界**：不记录仓库已经拥有的东西。四条判据命中任意一条即不记：①未来会话能从仓库得到吗（架构、文件路径、构建/测试命令、依赖清单、目录结构、git 历史）；②它是项目级指令吗（约定与「永远/绝不」类规则属于 `AGENTS.md`/`CLAUDE.md`，而记忆是本机私有、团队其他人看不到）；③它是任务状态吗（进度、下一步、已作废的计划属于 `STATE.md`/待办/issue）；④它是「刚刚做完了什么」的动作报告吗（产物本身就是记录）。为了让前两条可判定而不是凭感觉，每次蒸馏都会带上仓库上下文：`AGENTS.md`/`CLAUDE.md` 的正文（有界 2000 字符）加上 `README.md`、`STATE.md`、`TODO.md`、`CONTRIBUTING.md`、`ARCHITECTURE.md`、`CHANGELOG.md`、`docs/` 的存在清单；读取按 mtime+size 缓存，仓库没变时每轮只花几次 `stat`。剩下才是记忆的正当范围：环境与工具的坑、用户自己的偏好与纠正、以及仓库不可能知道的本机事实。另外，因为记忆是本机私有的，常驻召回指引会要求代理把「本质上是项目规则」的条目**升级**进 `AGENTS.md`/`CLAUDE.md`，然后 `memory_forget` 掉，避免两处漂移。

- **召回可测，且防止「劣币驱逐良币」**：注入的索引分两层——会改变行为的条目（decision/correction/prohibition/open）优先，其后才是最新的事实；同层排序中「刚被读过」的条目视同刚写入（`lastRecalledAt`），所以有用不会被年龄惩罚。`memory_detail` 每次打开条目计一次 `recallCount`，面板按条显示、表头显示总量。实测（约 7 小时真实使用）发现：纯新近度排序会让刚捕获的任务叙事把**被真正读过的平台知识**挤出索引（含一条 prohibition），而全部 15 条决策类合计只占 983 字节——这直接促成了索引分层与脚注改写。`npm run audit:recall` 读取 DSH 自己的会话日志（插件不记录召回事件）输出上述指标，只读、且必须逐帧解码 zstd（DSH 每条记录一个帧）。子代理**不注入常驻索引**，但保留工具可按需检索：实测三个子代理会话各自拿到完整索引，合计仅调用过一次记忆工具。

### 工具 schema 必须是以 `object` 为根的 JSON Schema

`ctx.tools.register()` 会把工具的 `parameters` **原样**交给模型提供方，不做任何编译。因此若直接传属性映射（`{ text: { type: 'string', required: true } }`），根节点没有 `type`，提供方会直接拒绝**整个请求**：

```
Invalid schema for function 'memory_add': schema must be a JSON Schema of type: "object",
got type: "null". (INVALID_REQUEST)
```

失败的是整轮请求而非单个工具——同一次请求里的所有工具全部不可用。`lib/harness.js` 的 `toolDefinition` 现在会按照 Harness 自身 `defineTool` 的规则，把简写编译成 `{ type: 'object', properties, required? }`；`assertParameters` 会在注册时就拦下不合规的 schema。`test/tools.test.js` 在装有 `@deepseek-ai/dsh-tools` 时直接调用 Harness 的真实编译器逐项比对，避免两边规则漂移。

### 运行完整功能所需的最低权限

**`仅可查看`（Read Only）即可运行全部功能。**

四种会话权限模式（仅可查看 / 工作区内修改 / 完全权限 / Auto review）约束的是**智能体的内置工具**，而非插件宿主代码：

- 文件工具（`read`/`write`/`edit`）经 `dsh-fs-sandbox`（沙箱化的 `ctx.fs` 提供方）围栏，其 README 明确写道：它限制的是"**模型对**文件的写入与编辑"，围栏"是在可信代码中检查**模型控制路径**的策略，而非内核边界"——即在文件工具层内检查，并非全局 `fs` 拦截。
- Shell 工具（`bash`/`pwsh`）以子进程方式由 `dsh-bash-sandbox`/`dsh-pwsh-sandbox` 隔离；插件代码运行在宿主进程，不在受限子进程内。
- `Auto review` 审查原生工具调用，不围栏插件宿主代码。

本插件用 `node:fs` 直接持久化（不经沙箱化的 `ctx.fs`），通过 `llm` 服务调用模型（非文件/Shell 操作），并注册自己的工具（其 `execute` 为宿主代码）。这些路径都不经过文件或 Shell 沙箱，因此会话权限模式不约束它们。存储位于 `$DSH_HOME/memory-curator/store.json`（工作区之外），在任何模式下写入均成功——包括`仅可查看`。

> 审批策略（仅可查看/工作区内修改下为 `ask`，完全权限下为 `never`）只管**升权**请求（工具以更宽沙箱模式重试）。本插件工具不带 `sandbox_permissions`、从不升权，故 `ask` 永远不会打断它。

## License

MIT
