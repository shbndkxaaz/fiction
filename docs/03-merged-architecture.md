# 03 · 合并架构（新项目：续写工坊 / Fiction Weaver）

## 1. 产品定义（一句话）

> 一份**书级知识库**，同时喂两条生产线：**聊天内注入（穿书/演戏）** 与 **编辑器内自动续写（写作）**；
> 写出来的新正文再自动回流成总结/节点/伏笔，形成「越写越懂这本书」的闭环。

两个上游恰好互补：

| 能力 | xu-xie-ji | novel-injector-2w | 合并后 |
|---|---|---|---|
| 原著入库（TXT→分段→清洗→节点/角色） | ❌ | ✅ 强 | 复用 |
| 阶段划分 + 向量召回 + 预算裁剪 | ❌ | ✅ 强 | 复用 |
| 聊天注入（`CHAT_COMPLETION_PROMPT_READY`） | ❌ | ✅ | 复用经验 |
| 世界书/角色 canon（别名/多身份/退场/知情） | 关键字触发 | ✅ 阶段化 | 以 NI 为主，吸收 X 的关键词触发 |
| 分层总结（小→大合并） | ✅ 强 | ❌ | 复用 |
| 长期伏笔（未来规划） | ✅ | 只有节点里的 `【伏笔】` 标记 | 合并成一张表 |
| 自动续写工作台（多分支/定向/扩写/改写） | ✅ | ❌ | 复用 |
| 自动分章 + 原创归档 | ✅ | ❌ | 复用 |
| 去 AI 味润色 | ✅ | ❌ | 复用 |
| 数据体检 / 运行记录 / 注入预览 | ❌ | ✅ | 复用 |

**闭环图**

```
        ┌──────────── 原著 TXT ────────────┐
        │ import → chunk → 清洗(LLM) →      │
        │ nodes / chars / world / style     │
        └───────────────┬──────────────────┘
                        ▼
                ┌── 知识库 (story) ──┐
                │ chunks  nodes      │
                │ chars   world      │
                │ stages  style      │
                │ summary 伏笔 进度  │
                └───┬────────────┬───┘
       注入管线(读) │            │ 续写管线(读+写)
                    ▼            ▼
        CHAT_COMPLETION_    generateRaw → 分支 → 润色
        PROMPT_READY 注入    → 保存 → 自动分章
                    │            │
                    └────► 回流总结 / 新节点 / 伏笔状态 ◄──┘
```

## 2. 怎么"合"：不是把两个 index.js 拼起来

两个上游都是「单入口 + 巨型 index.js」（8.5k / 8k 行）。**直接合并入口文件等于制造 16k 行不可维护代码**。
采用的策略是 **保留纯逻辑、重写装配层**：

| 上游代码 | 处置 | 理由 |
|---|---|---|
| `novel-injector/lib/story-data.js`（节点/阶段查询） | **移植**（去 `ni` 前缀可保留） | 纯函数、无 DOM |
| `lib/injection-system.js`（预算裁剪/阶段直注/预告） | **移植为主，并做通用化** | 已是最干净的纯函数模块 |
| `lib/prompts.js`（清洗 JSON schema 等） | **移植** | 文本常量，价值高 |
| `lib/vector-system.js`（Embedding/召回） | **二阶段移植**（先不引入） | 依赖多，v1 可先用关键词/直注 |
| `lib/char-canon.js`、`knowledge-matrix.js`、`health-system.js` | **移植** | 纯函数 |
| `lib/storage-system.js` / `transbook-system.js` / `ui-system.js` | **参考重写** | 强绑 chat_metadata 与旧 UI |
| `xu-xie-ji` 的分层总结 / 自动分章 / 润色 / 多分支 | **抽取重写** | 逻辑埋在 8.5k 行里，需剥离 DOM |
| 两个上游的 `template.html` / `style.css` | **不复用** | 体量过大且风格冲突，新项目重新设计 |

### 命名与代码风格约定
- 新项目前缀 `fw`（Fiction Weaver）：`fwBuildInjectionBlocks`、`fwChunkText`、`FW_EXT_NAME`。
- 与上游保持一致的部分：`lib/` 放纯函数模块、`tests/*.test.mjs` + `tests/run-all.mjs`（零依赖）、提示词集中在 `lib/prompts.js`。
- **所有可测逻辑必须是纯函数**（不 import ST 的 `script.js`），ST 的 import 只允许出现在 `index.js`。

## 3. 目录结构（v1 落地版）

```
SillyTavern_fiction/            ← 这就是扩展目录本身（放进 third-party/ 即可）
├── manifest.json
├── index.js                    ← 唯一装配层：ST 事件、设置、UI 绑定、两条管线调度
├── template.html               ← 设置面板
├── style.css
├── lib/
│   ├── store.js                ← story 作用域存储（localStorage）+ 设置读写
│   ├── text.js                 ← 分段/章节识别/句界截断/Token 估算
│   ├── prompts.js              ← 清洗与总结提示词
│   ├── clean-api.js            ← OpenAI 兼容 chat/completions 调用
│   ├── kb.js                   ← 清洗结果解析 → 知识库增量合并、摘要块、查询
│   └── injection.js            ← 注入块构造、Token 预算装配、chat 数组插入
├── tests/  (_paths / run-all / text / kb / injection)
└── docs/   (01 分析 / 02 分析 / 03 架构 / 04 路线)
```

## 4. 统一数据模型（书 = story，不是 chat）

```js
story = {
  id, title, createdAt, updatedAt,
  source:  { fileName, totalChars, chapters: [{ idx, title, start, end, chars }] },
  chunks:  [{ idx, chapterIdx, text, cleaned, done, nodeIds }],       // 原文分段（100KB 级）
  nodes:   [{ id, chunkIdx, stageIdx, lane, title, body, events[],
              foreshadow[], chars[], time, location, blocked }],      // 剧情节点
  chars:   [{ id, name, aliases[], identity, appearance, personality,
              relations[], exitStage, secretFrom, enabled }],        // 角色 canon
  world:   [{ id, category, label, content, enabled, keywords[] }],   // 世界设定
  stages:  [{ idx, title, summary, enabled }],
  style:   { name, guide, source },
  memory:  { summaries: [{ id, level, start, end, text }],            // small / major
             foreshadows: [{ id, text, weight, status, stageIdx }] },
  progress:{ stageIdx, nodeIdx, updatedAt },
  inject:  { /* 各类内容的 位置/深度/角色/预算（对齐 NI 的 cfg.*Inj*） */ },
}
```

关键决策：

1. **书维度存储**（学 xu-xie-ji），而不是 chat 维度（NI 用 `chat_metadata`）。
   理由：续写是「一本书跨多个章节/多个对话」的事；chat 只保存**进度指针**（`chat_metadata.fw = { storyId, stageIdx, nodeIdx }`）。
2. **一句话原则**：`chunks` 是原文（可复核），`nodes` 是索引（可注入），`chars/world` 是设定（可编辑），`memory` 是时间线（可增长）。
3. 伏笔统一一张表：既收录清洗时节点里抽出的 `【伏笔】` 标记，也收录用户在「定向续写」里登记的规划，并带 `status: planted / pending / paid-off`。

## 5. 两条管线（共用 `lib/`，这是合并的价值所在）

### 5.1 注入管线（聊天内，学 NI）
```
CHAT_COMPLETION_PROMPT_READY (eventData.chat)
  → fwBuildInjectionBlocks(story, { progress, recentMessages, settings })
      [角色人设 / 世界设定 / 当前阶段剧情 / 未来预告 / 分层总结 / 长伏笔 / 文风]
  → fwAssembleInjection(blocks, { maxTokens })      // 预算裁剪，边界截断，记录 omitted
  → fwInsertIntoChatMessages(eventData.chat, {...}) // 默认并进第一条 system
```

### 5.2 续写管线（编辑器内，学 xu-xie-ji）
```
用户点「续写」→ fwBuildContinuationPrompt(story, { instruction, targetWords, blocks })
  → getContext().generateRaw({ systemPrompt, prompt })
  → 分支预览 → 选中 → 润色（可选）→ 保存章节
  → 自动分章（句界）→ 触发增量总结 → 抽取新节点/伏笔 → 写回 story
```

**两者共用 `fwBuildInjectionBlocks`**：聊天里注入的「当前阶段剧情 + 人设 + 世界 + 总结 + 伏笔」，
在续写时就是同一个数组 —— 不再出现「酒馆里演的和编辑器里写的不是同一本书」的割裂。

## 6. 存储与预算基线（沿用上游默认值，别自己发明）

| 项 | 值 | 来源 |
|---|---|---|
| 分段大小 | 100 KB（可调小） | NI `chunkKb` |
| 每块字数（向量/直注粒度） | 1000 字 | NI `NI_VEC_CHUNK_CHARS_DEFAULT` |
| 单轮注入预算 | 32000 token（阶段直注）；20000（向量块） | NI |
| 估算比 | 1 字 ≈ 0.667 token（`CHARS_PER_TOKEN = 1.5`） | NI |
| 自动总结触发 | 6000~12000 字，推荐 8000~10000 | X README |
| 小总结合并 | 8 条合 1 条大总结，保留最近 3 条 | X `autoSummaryMergeCount/KeepRecent` |
| 自动分章 | 6000 字 + 完整句尾 | X `autoChapterSize` |

## 7. 里程碑（每一步都能单独验收）

| # | 交付 | 验收标准 | 状态 |
|---|---|---|---|
| **M0** | 骨架 + 纯函数库 + 测试 | `node tests/run-all.mjs` 全绿；酒馆里能打开面板、能导入 TXT 并分段 | ✅ 已完成 |
| **M1** | 清洗流水线（真调 API，产出 nodes/chars/world） | 一段原文 → 严格 JSON → 知识库可见计数；失败可续跑 | 🟡 代码已通（假 API 验证过），待真 Key 跑一遍 |
| **M2** | 注入管线（角色/世界/当前阶段剧情/总结）+ 面板显示「本轮发了什么」 | 聊天时注入生效，预览与实际一致 | 🟡 逻辑已通；待与真酒馆请求比对 |
| **M3** | 续写管线（`generateRaw` + 多分支 + 定向续写） | 能生成 1~3 分支、选中插入、结果进正文 | 🟡 逻辑已通；待真模型手感调 prompt |
| **M4** | 记忆闭环（自动分章 → 增量总结 → 小总结合并大总结；伏笔状态流转） | 写 1 万字后仍能接上前文 | ⬜ 未开始（`fwPickSummariesToMerge` 等纯函数已就位） |
| **M5** | 阶段/进度/未来预告/召回屏蔽 + 向量召回（移植 NI vector-system） | 长篇不跑偏；屏蔽生效 | ⬜ 未开始（阶段/屏蔽/未来预告已有基础实现） |

**M0 的验收是怎么验的**（不靠手点）：`tests/` 下 8 个文件、277 条断言，零依赖、`exit code` 即门禁。

- `text / kb / injection / clean-api`：纯函数单测。
- `ui-contract`：模板里的 `fw-*` id ↔ `index.js` 的引用、设置项双向同步、manifest 字段。
- `wiring`：`index.js` 的每个 import 都在 `lib/` 里真实存在；`lib/` 不许依赖酒馆模块；关键函数都在且不重复定义。
- `smoke`：假 DOM + 桩子把 `index.js` 真跑一遍 —— 建书 → 导入 TXT → 清洗 → 预览 → 发送前注入 → 推进度 → 续写分支 → 润色 → 草稿落盘 → 导出，共 48 条。

## 8. 风险与须知

1. **许可/授权**：两个上游仓库**都没有 LICENSE 文件**（xu-xie-ji 的 README 提到「二创」授权、致谢 discord 作者群；novel-injector 未声明）。
   → 正式发布前必须①向作者要书面许可，或在 README 显著位置标注来源与致谢；②移植的 `lib/` 文件顶部保留原作者说明。这一步不能省。
2. **"合并两个巨石"的诱惑**：任何「先复制过来能跑再说」的做法都会让新项目立刻变成 16k 行不可测。已用「纯函数进 lib + 装配在 index.js」的边界挡住。
3. **API 成本**：清洗 + 总结 + 润色三条链都要花钱，v1 必须能「不清洗也能用」（手工世界书 + 关键词触发，即 X 的降级路径）。
4. **不做的**：移动端专门优化、主题编辑器、mobi 解析、多语言 UI —— v1 全砍。

