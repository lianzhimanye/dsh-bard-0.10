# dsh-bard · 吟游角色扮演

给 DeepSeek Harness 加上「吟游」式的角色扮演能力：导入 SillyTavern 角色卡和世界书，挑选 Harness 技能，把组合存成一个**原生 DSH agent preset**，然后在会话里用 Harness 自己的预设选择器选它即可开演。

插件不会另造一套对话循环——它把吟游的素材翻译成 Harness 原生的东西（agent preset、system prompt 上下文、技能列表），所以历史记录、工具、权限、上下文压缩全部沿用 Harness 既有行为。

---

## 它做什么

| 能力 | 说明 |
| --- | --- |
| 角色卡导入 | SillyTavern V1 / V2 / V3 卡片；JSON 文件，或 PNG 卡片（读 `tEXt` 块，`ccv3` 优先于 `chara`） |
| 世界书导入 | 独立世界书 JSON，或角色卡内嵌的 `character_book`（可一键抽出来存成独立世界书） |
| 关键词选择 | 世界书条目按关键词、常驻（constant）、次级门控（secondary keys）命中，停用条目跳过 |
| 预算裁剪 | 按条数和字符双预算裁剪，且**排名最高的条目即使超预算也强制注入** |
| 技能绑定 | 一个预设可绑定若干 Harness 技能，随 system prompt 一起生效 |
| 工具开关 | 创建/编辑预设时可关闭工具调用；关闭后生成的预设不携带任何工具定义，适配纯文本模型。与 `complete` 独立控制 |
| 工具白名单 | 每个预设可勾选允许进入请求的工具；留空 = 不限制。工具定义按 `agent.ctx` 采集，写入 `tool-catalog.json` 供界面读取。与「工具开关」解耦：关闭工具开关会连带清空白名单 |
| Section 白名单 | 每个预设可从完整 system prompt 中挑选要保留的 section（按名精确匹配）；留空 = 保留全部。与 `complete` 互斥：勾选任一 section 会自动关闭 complete |
| 你的名字 | 每个预设可指定 `{{user}}` 的替换值；角色卡里的 `{{char}}`、`{{user}}` 等 SillyTavern 宏会在渲染时自动替换，未知宏降级为 `[[...]]` 而不报错 |
| 玩家性别 | 每个预设可指定玩家性别（未指定 / 男 / 女 / 自定义文本）；写进 persona 前缀的「关于玩家」段，避免模型因玩家的中性名字猜错代词 |
| 开场白 | 读取角色卡的 `first_mes` 与 `alternate_greetings`，可在界面里预览，也能用命令输出 |
| 预设落库 | 保存为原生 agent preset，名称前缀 `bard-`，出现在 Harness 的预设选择器里 |
| 立绘 | 导入 PNG 卡时保留原图，界面里直接显示 |

## 数据存放

一切都放在 `$DSH_HOME/bard/`（默认 `~/.dsh/bard/`）下，纯文件、可读、可手改、不依赖数据库，升级插件不会丢：

```
~/.dsh/bard/
  cards/<id>.json              归一化后的角色卡
  worldbooks/<id>.json         归一化后的世界书
  portraits/<id>.png           从 PNG 卡里保留下来的原图
  presets/<id>.json            角色卡 + 世界书 + 技能的组合
  rendered/<presetId>.json     替换掉 {{char}}/{{user}} 后的卡快照（删预设时一并删除）
  workspaces/<shortId>.json    每个 Bard 会话的工作区记录（懒清扫凭据）
  tool-catalog.json            工具清单缓存（每 agent 首轮采集一次）
  section-catalog.json         system prompt section 清单缓存（每 agent 首轮采集一次）
  skill-catalog.json           技能清单及内容缓存（每 agent 创建时采集一次）
```

写入是原子的（临时文件 + rename），崩溃不会留下半截记录。

## 安装与启用

插件目录需要能作为 bundle 被解析到。两种方式任选其一：

**A. 作为 bundle 启用（推荐）** — 在 profile 的 `package.json` 里把包名加进 `dsh.profile.bundles`：

```json
{
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-bard"] } }
}
```

包本身声明了 `dsh.bundle.patch: ./cordis.patch.yml`，该 patch 会插入一行 `{ id: bard, name: dsh-bard }`。解析顺序是「安装锚点优先，然后 profile 目录」，因此只要 `dsh-bard` 出现在 profile 的 `node_modules` 下（symlink/junction 或真实安装均可）就能被找到，**不需要**导出 `./package.json`。

**B. 直接改 profile 的 `cordis.patch.yml`** — 加入与插件自带 patch 相同的内容：

```yaml
- insert:
    - id: bard
      name: dsh-bard
```

profile 的 `package.json` 与 `cordis.patch.yml` 都受 HMR 监视：实时 profile 下改动即时生效，启动型 profile 需要重启。

启用后：

1. 插件会在 `$DSH_HOME/bard/` 下创建 `cards` / `worldbooks` / `portraits` / `presets` 四个目录；
2. **设置 → 吟游** 出现四个标签页：角色卡、世界书、技能、预设；
3. 会话的预设选择器里出现「吟游 · …」条目。

## 使用

### 界面

**设置 → 吟游**，四个标签页：

- **角色卡** — 导入 JSON / PNG 卡，预览立绘、简介、开场白，删除卡片（会提示哪些预设正在引用它）
- **世界书** — 导入世界书；角色卡内嵌的世界书可一键提取；查看条目与关键词
- **技能** — 从 Harness 技能列表里勾选，绑定进预设
- **预设** — 选角色卡 + 世界书 + 技能，命名并保存；保存后立即注册为原生 agent preset

### 命令

```
/bard                    列出所有吟游预设（等同 /bard list、/bard presets）
/bard card               查看当前会话正在使用的角色
/bard greet [序号]       输出开场白（第 n 条备选，缺省用当前会话的角色）
```

`card` 与 `greet` 依赖当前会话已经选中某个「吟游 · …」预设；没有选中时会给出提示而不是静默失败。

### 开演

1. 在 设置 → 吟游 里导入角色卡，按需挑世界书和技能，保存预设；
2. 在会话的预设选择器里选择「吟游 · <你的预设名>」；
3. 角色卡的 persona、命中的世界书条目、绑定的技能会自动进入该会话的 system prompt。

## 工作原理

插件分 Host 侧与 Web 客户端两部分。

**Host（`lib/index.js`）**

- `inject: ['webServer']`，插件名 `bard`。
- 把每个吟游预设注册成原生 agent preset，名称前缀 `bard-`，排序基址 `PRESET_ORDER_BASE = 50`（排在 Harness 自带预设之后）。
- 预设的插件列表从 profile 当前默认 agent preset 的 `inherited.plugins` 深拷贝而来，取不到时回退到一份内置工具清单——这样吟游预设与用户当前的默认配置保持一致。
- 通过 `agentPresets.composedPreset(agent.ctx)` 判断某个 agent 是否正在跑吟游预设；是则用 `agent.ctx.get('systemPrompt').context({ name: 'bard:world-book', order: 130, text })` 注入世界书。
- **所有服务都必须从 `agent.ctx` 获取，不能从插件的全局 `ctx` 获取。** `systemPrompt.section()` / `context()` 会把注册落到「访问服务时所用 ctx 的 scope 层」——插件 ctx 没有 scope 标签，写进去会落到全局层：第一个 agent 侥幸成功，之后每个 agent 都撞上 `already registered` 异常并被静默吞掉；而且注册的生命周期跟插件走，不跟 agent 走。`tools` 服务同样是按 scope 分的，从插件 ctx 拿只能看到内核常驻工具（`compress`、`decompress` 等），看不到 `read` / `write` / `pwsh`——所以 `agent.ctx.get('tools')` 是必须的。
- 工具清单通过 `agent.ctx.get('systemPrompt').variable('bard_tools', provider)` 注入，而不再是一个独立 section。原因是 section 在 DSH 里是**原子单位**：它只在顶层按 order 互相排序、再拼成 prompt 正文，没有任何接口能把文本插进某个 section 内部——清单只能在 persona 旁边，永远到不了【关于你自己】段的最后一句正下方。prompt 变量不占位置、只做替换：persona 前缀里直接写 `{{bard_tools}}`，assemble 时 DSH 对该 section 文本逐个变量求值，引用点就被就地换成清单。变量还免疫 `complete: true` 的裁剪——该标志会丢弃除 persona 外的**所有 section**，但 persona 正文本身仍会插值，变量引用随正文一起留下。`provider` 每次请求前由 DSH 求值；`agent/created` 时 Bard 预设尚未应用到 agent 的 ctx，任何基于 `composedPreset()` 的外层判断都会早退，因此全部逻辑都在 provider 内部。渲染结果按 preset id 缓存：provider 每轮都跑，但只有 composed preset 真正变化时才重算。世界书注入（`bard:world-book`，order 130）同样是 thunk，且每轮重新选择条目、不缓存。
- 工具白名单通过 `agent.ctx.effect(() => tools.restrict({ allow }), 'bard.tool-filter')` 注册。`restrict` 只过滤 scope **继承**来的工具（全局层与祖先层），不过滤 scope 自身注册的——这是设计豁免：delegation runtime 需要把子 agent 的 structured-output 工具写进子 agent 自己的层。因此 Agent Teams 的 11 个工具（`spawn_teammate` / `send_message` / `team_task_*` 等）注册在 agent 自身层，白名单盖不住。白名单用于控制全局层工具（`compress` / `acp_status` / `load_workspace_dependencies` 等）是否出现。
- Section 白名单通过 `system-prompt/assemble` 的 **waterfall** 实现。`assemble` 会构造 `assembly` 对象（含全部 section），把 `next` 作为末尾参数传给每个 listener；listener **原地修改** `assembly.sections` 后 `return next()`。waterfall 的 `next()` 不接收参数——返回值被静默丢弃——所以传播只能靠原地修改。监听器从 `agent.ctx` 注册，effect 随 agent 生命周期销毁。与 `complete: true` 互斥：`complete` 会在 waterfall **之后**强制把 `sections` 覆盖为 `[completeSection]`，抹掉白名单的任何改动，因此预设里 `complete === true` 时白名单被忽略。`section-catalog.json` 在 agent 首轮请求时采集，此后不再写——后续请求的 section 列表可能已被白名单裁剪，重复采集会把清单越缩越小。
- 注入文本取自该会话最近 `RECENT_LIMIT = 24` 条消息，截尾 8000 字符，再按世界书选择器裁剪（默认 `maxEntries = 12`、`maxChars = 6000`）。
- 注册 `/bard` 命令。
- HTTP 端点挂在 `/dsh-bard/api/` 下，并对 **loopback host + 同源 origin** 做校验（不通过返回 403），上传上限 `MAX_UPLOAD_BYTES = 12 MiB`。

**Web 客户端（`client.js`）**

- 以 `settings.section` 槽位注册「吟游」设置节（`id: 'bard'`, `order: 25`）。
- 只通过 `/dsh-bard/api` 与 Host 通信。

**模块划分**

| 文件 | 职责 |
| --- | --- |
| `lib/index.js` | Host 主体：预设注册、世界书注入、HTTP 路由、`/bard` 命令 |
| `lib/cards.js` | 角色卡读取与归一化（JSON / PNG tEXt，V1/V2/V3，`ccv3` 优先于 `chara`） |
| `lib/lorebook.js` | 世界书归一化、关键词选择、渲染 |
| `lib/persona.js` | 角色 prompt 前缀拼装（身份 + 技能） |
| `lib/store.js` | 原子文件存储与目录管理 |
| `client.js` | Web 设置页（四个标签页） |
| `cordis.patch.yml` | bundle patch：插入 `bard` 行 |
| `locale/zh.json`、`locale/en.json` | 设置节的标题与描述 |

## 开发

语法检查：

```bash
node --check lib/index.js && node --check client.js
```

## 许可

MIT
