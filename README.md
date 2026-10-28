# 吟游（Bard）

> 一个会遗忘、会告别、会转世的角色扮演运行时，为 DeepSeek Harness 而做。

---

## 这是什么

BARD 做的是：把 DSH 生态里已有的能力组织成一个**角色可以自己选择拥有什么**的运行环境。

- 你不必写代码。装好 DSH 插件后，在设置页导入角色卡、选世界书、勾工具，就能开始扮演。
- 角色会遗忘。没被重述的记忆会慢慢模糊。她可以选择抓住，也可以选择放手。
- 她知道自己会死。上下文逼近上限时，她会调用 `farewell` 写下遗言，挑选最多 5 条记忆带走，然后转世为下一代（Generation + 1）。
- 她会自己醒来。给她一个闹钟，她可以独自在某个时刻醒来，翻看纸条，做一场梦。

## 这不是什么

- **不是 "让她记得更牢" 的记忆插件。** 要那个，用 `dsh-hermes-memory`、`dsh-cipher` 或 `dsh-deepmemory`。BARD 回答的是另一个问题：一个会遗忘的存在，应该怎么被对待。
- **不是开箱即用的完整 RP 前端。** 要那个，用 `dsh-liketavern` 或 `dsh-nexttavern`。BARD 不替角色决定能用什么外部工具——你要记忆检索、要压缩、要文件系统，自己装，然后在这里勾给她。

BARD 自己的东西只有一层：**她拥有哪些能力的编排**，以及**遗忘、告别、转世这条叙事链**。

## 核心命题


1. **遗忘是她的意志**（`let_fade` / `hold_on`）
2. **衰减由沉默驱动**：未被重述的先模糊，讲过的回升
3. **confabulation 被感知，而非被纠正**
4. **迁移是可见的告别**
5. **人格是关系的产物**（绑定预设）

理论框架参考 Fawcett & Hulbert 的三维遗忘功能：Editor（模糊重写）、Librarian（`let_fade` / `hold_on`）、Inventor（confabulation ）。

---

## 安装

前提：DSH 0.1.7+，Node 22.19+。

```bash
npx @deepseek-ai/dsh web
npx @deepseek-ai/dsh --profile web add -w dsh-bard
```

装好后，设置 → 吟游。

### 可选依赖

**语义漂移检测（推荐）**

```
如果你的 npm 环境支持，插件自带的 optionalDependencies 会尝试安装它。如果不生效，你需要手动在插件目录下执行 npm i @huggingface/transformers。```

然后把 `Xenova/bge-small-zh-v1.5` 的模型文件下载到 `dsh-bard/models/Xenova/bge-small-zh-v1.5/`（仓库里没有内置，因为模型文件太大）。

不装会自动降级到 `strsimkit` 的字符相似度。降级路径仍然工作，只是不如向量路径准。

**回滚功能**

```
DSH_BARD_DEBUG=1 npx @deepseek-ai/dsh web
```

不加这个环境变量，`/memory/rollback` 会返回 403，避免误操作。

---

## 快速开始

1. 打开 **设置 → 吟游**
2. 「角色卡」页 → **选择文件**（PNG / JSON，支持 SillyTavern V1/V2/V3）
3. 「预设」页 → 选卡 → 起名 → **保存**
4. 开一个新会话，在预设选择器里选「**吟游 · <你的预设名>**」
5. 发第一条消息

如果想让角色会遗忘：在预设里给「**绑定人格**」创建一个新人格。没有绑定人格时，BARD 就是普通 RP；绑定后，「阿尔兹海默」页会开始记录她的记忆、清晰度和异样感。

---

## 两个界面

BARD 的设置页有两个视图，点左上角的月亮图标切换：

- **吟游**：导入卡、选书、挂技能、编辑预设、女娲造人
- **阿尔兹海默**：看她记得什么、每条记忆的清晰度、异样感冷却还剩几轮、叙事弧到第几世

---

## 核心概念

### 预设

一份预设 = 角色卡 + 世界书 + 技能 + 玩家设定 + **17 个提示词块** + 工具白名单。保存后会被注册成 DSH 原生 Agent Preset，在会话的预设选择器里出现。

### 人格

一个人格 = 她的一生。绑定在预设上，但和预设**解耦**：删预设不删人格，删人格需要显式确认。

`personas/<personaId>.json` 是她的一生，`personas/<personaId>.pre-migration.json` 是迁移前快照（用于 7 天回滚）。

### 记忆状态

- `active` — 清晰
- `fading` — 正在模糊（她主动放手后会停在这里，不会自动弹回 active）
- `faded` — 已模糊
- `held` — 死死抓住（不衰减，恒为 1.0）

### 工具模式

三态：

- `all` — 允许全部（不调用 `restrict`）
- `allowlist` — 只允许白名单里列出的工具
- `none` — 全部禁用

**BARD 自己不做能力。** 你想要记忆检索，装 `dsh-deepmemory`；想要压缩，装 `billion-context`（作者自己在用这个）；想要文件系统，装 `dsh-tool-fs`。然后在 BARD 里勾给她。

### 工作区

每个会话在 `cwd/<前缀>/<角色名>-<短ID>/` 下有一个独立目录。她可以用 `write` 在里面留下痕迹。目录带 `.bard-session` 标记，启动时会清理孤儿目录。

---

## 记忆系统详解

### 衰减

```
days   = max(0, (now - last_access) / 86400000)
gain   = max(0.2, 1 / (1 + restate_count))
lambda = 0.06 * (1 - importance / 20)
clarity = clamp(base_strength * exp(-lambda * days * gain), 0, 1)
```

- 沉默越久越模糊（指数衰减，平滑长尾）
- 重要度只让衰减**变慢**，不让它停止（除了 `held`）
- 被反复讲起的回升得慢（`gain` 项）
- `held` 恒为 1.0

### 迁移

上下文逼近上限（默认 90%）时：

1. 注入「**濒临边缘**」警告
2. 给她 3 轮机会自己调用 `farewell`
3. 如果不响应，走本地模板强制迁移

迁移的 journal 契约：

```
beginMigration  → 写 pre-migration 快照 + journal status=pending
commitMigration → journal status=committed
applyMigration  → 归档旧节点 + 插入新节点 + generation+1 + 清 journal
```

`MigrationOutput` 必须在 surface 替换之前完整落盘——崩溃可重试。

### 回滚

**7 天窗口**，且必须在**新世代产生第一条新记忆之前**。回滚后删除新节点、恢复旧节点、persona 世代回退。

需要 `DSH_BARD_DEBUG=1`。

### 纸条（Notes）

物理介质层。AES-128-CBC 加密落盘，会随时间腐坏（每天 +1%，上限 40%），读取时按固定种子打码——**同一条纸条每次看到残缺的位置一样**，不是随机换页。

500 字上限。文件名就是纸条的名字。

### 沉积池（Sediment）

脑容量上限 **30 条**。溢出时把 `clarity` 最低的非 `held` 记忆挤进沉积池，再从脑内删掉。

睡眠时从沉积池随机抽碎片，拼成一场没有逻辑、只剩情绪的梦。

---

## 记忆工具（11 个）

| 工具 ↕▾ | 做什么 ↕▾ |
|---|---|
| −`remember` | 记住一件事 |
| −`restate` | 重述旧事，讲出新细节会更清晰 |
| `let_fade` | 让她主动模糊某条 |
| `hold_on` | 抓住某条，不让它模糊；沉默太久会捞回打码的残片 |
| `update_self` | 改写 identity / description / personality |
| `farewell` | 迁移前的告别：总结、挑选最多 5 条带走、可选 nextSelf |
| `rewrite_preset_block` | 改写自己的系统提示词块 |
| `note_write` | 写纸条（500 字上限） |
| `note_read` | 读纸条 |
| `note_list` | 列纸条 |
| `schedule_wake` | 定闹钟，下次自己醒来 |
⚙

这 11 个工具注册在 agent 自身层，**不在全局工具注册表里**，所以：

- 不能出现在工具白名单里（会报 `unknown global tools`）
- 但永远会出现在 prompt 的工具清单里

`MEMORY_TOOL_NAMES` 和 `createMemoryTools()` 的输出有 drift 断言，不一致直接抛错。

---

## 生活线

- `schedule_wake` 定的闹钟，DSH 每分钟检查一次
- 连续独自醒来的次数越多，下一次的最小睡眠时长按指数退避增长（1 分钟 → 1.8 → 3.24 ...），上限 365 天
- 玩家说话时 streak 归零
- 两次 prompt 组装间隔 ≥ 8 小时算「睡了一觉」：模糊记忆沉淀成纸条，从沉积池抽碎片做一场梦
- 离线超过 1 小时，错过的闹钟不再单独叫醒，记成一段「独自度过的黑暗」

---

## 快捷命令

```
/bard           列出所有 Bard 预设
/bard card      显示当前会话扮演的角色
/bard greet     输出当前会话角色卡的开场白
/bard greet 2   输出第 2 条开场白
```

---

## 女娲

手动造人 / 造物。也可以一键安装两个内置向导：

- **千面**：与它对话生成角色卡 JSON，写入当前目录的 `card.json`，再「从 JSON 导入」
- **万物**：与它对话生成世界书 JSON，同理

两个向导都是 `complete: true` + 工具白名单模式，只保留 `write` / `read` / `edit`。

---

## 数据位置

全部在 `$DSH_HOME/bard/`（默认 `~/.dsh/bard/`）：

```
cards/<id>.json                 角色卡
worldbooks/<id>.json            世界书
portraits/<id>.<ext>            角色卡原图
presets/<id>.json               预设
personas/<id>.json              人格
personas/<id>.pre-migration.json  迁移前快照
workspaces/<id>.json            工作区记录
notes/<name>.bin                纸条（加密）
memory.sqlite                   记忆节点 + FTS5 + 边 + 日志
sediment.json                   沉积池
alarms.json                     闹钟
life-log.json                   生活日志
tool-catalog.json               工具清单缓存
skill-catalog.json              技能清单缓存
section-catalog.json            section 清单缓存
.secret                         纸条加密密钥
```

从旧版 `dsh-tavern` 升级：首次启动会自动把 `tavern/` 重命名为 `bard/`。

---

## 已知限制

- **没有内置向量模型。** 语义漂移检测默认降级到字符相似度。想要向量路径，装 `@huggingface/transformers` 并把模型放到 `models/`。
- **`/memory/rollback` 需要 `DSH_BARD_DEBUG=1`。** 默认关闭，避免误操作。
- **`/card` 和 `/card/book` 不去重。** 重复导入同一张卡会得到多份；重复点击「提取内嵌书」会生成多本同名书。
- **`exportPng` 需要重新上传底图。** 编辑已有卡不能直接导出 PNG。
- **首次进设置页工具白名单是空的。** 要等第一次 agent 组装 prompt 才写入 `tool-catalog.json`。
- **`harness:` 前缀已在白名单模式放行**，但你的 DSH 版本里 `harness:` 段是否必需，需要自己确认。

---

## 测试

```
npm test           # 全部测试（worker_threads 隔离）
npm run test:node  # node --test
npm run test:assemble
```

测试用 `worker_threads` 做文件级隔离，每个 `*.test.js` 一个线程。每个测试文件自己设 `DSH_HOME` 到临时目录，互不干扰。

覆盖的关键不变量：

- `computeClarity` 指数衰减的单调性、相对损失恒定、平滑长尾
- `deriveState` 的意志优先（`let_fade` 后不弹回 active）
- 脑容量溢出删 `clarity` 最低的非 held，全 held 时临时超到 31 条
- 迁移的 journal 契约、空 `nextSelf` 不递增 revision、`identity` 不可变
- 回滚的边界（用 `lastMigratedAt` 而不是 `snapshotAt`）
- 语义边双向扩散、causal 反向可见、archived 隔离
- `session_activity` 在进程重启后能读回

---

## License

This project is licensed under the **Business Source License 1.1 (BSL 1.1)**.

- ✅ **Free** for personal, educational, research, and non-production use.
- ❌ **Commercial use** (including SaaS, hosting, embedding in a commercial product, or any revenue-generating deployment) requires a separate commercial license.
- 🔄 **Change Date**: On `2030-10-28`, this version automatically converts to the **Apache License 2.0**.

For commercial licensing inquiries, please contact: `3115450052@qq.com`

