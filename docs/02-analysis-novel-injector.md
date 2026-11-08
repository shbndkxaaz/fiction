# 源码分析 ②：`xianyuan123/novel-injector-2w`（小说注入器）

> 采集方式：`git clone --depth 1 https://github.com/xianyuan123/novel-injector-2w` → `_refs/novel-injector-2w/`

## 1. 仓库形态（模块化 ESM + 自建测试）

| 文件 | 行数 | 作用 |
|---|---|---|
| `manifest.json` | 12 行 | `display_name = Novel Injector - 小说上下文注入`、`loading_order = 200`、版本 `2026.11.08` |
| `index.js` | 7950 | 装配层：settings 默认值、UI 事件、注入主链 `onPromptReady`、转书弹窗 |
| `lib/prompts.js` | 760 | 全部提示词：清洗 JSON schema、角色扮演、世界设定抽取/压缩、抽取指令 |
| `lib/story-data.js` | **6531** | 剧情节点 / 阶段 / 角色 / 偏差 的数据结构与查询（最大模块） |
| `lib/storage-system.js` | 2096 | 设置持久化、chat_metadata、重数据（服务端文件）、导入导出、快照库 |
| `lib/transbook-system.js` | 2512 | 穿书模式：当前节点、状态栏、自动推进、跨阶段 |
| `lib/vector-system.js` | 2370 | Embedding 调用、分块、召回、加权查询、关键词命中、溯源 |
| `lib/world-system.js` | 1816 | 世界设定分类、AI 生成、偏差分析（deviation）与聊天变更清理 |
| `lib/ui-system.js` | 1436 | 主题、状态栏渲染、分页、批量勾选 |
| `lib/api-system.js` | 1386 | 清洗 API、消息组装、`setExtensionPrompt` 注入包装 |
| `lib/cleaning-system.js` | 1365 | 清洗流水线：分段 → 请求 → 解析 → 剧情/角色入库、续跑、自动续跑 |
| `lib/injection-system.js` | 682 | **纯函数注入预算**：Token 上限、阶段直注、未来预告 |
| `lib/offscreen-system.js` | 275 | 后台动向（其他视角推演） |
| `lib/clean-request.js` | 236 | 单次清洗请求的消息结构 |
| `lib/health-system.js` | 216 | 数据体检 7 项 |
| `lib/timeline-system.js` | 184 | 时间线视图（主线/支线/转折泳道） |
| `lib/char-canon.js` | 453 | 角色设定规范化：别名、多身份、退场阶段、按阶段关系与知情 |
| `lib/char-filter.js` | 151 | 角色搜索 haystack |
| `lib/knowledge-matrix.js` | 110 | 知情矩阵 |
| `lib/advance-judge.js` | 101 | 自动推进判定（模型判断「节点演完没」） |
| `lib/autosave-system.js` | 136 | 防抖自动保存控制器 |
| `template.html` | 1971 | 全部面板 HTML |
| `style.css` | ~9k 行级 | 主题化样式 |
| `tests/*.test.mjs` 24 个 + `run-all.mjs` | — | **零依赖**测试：`node tests/run-all.mjs` |
| `更新记录.md` | 90 KB | 变更日志 |

导入约定（值得照抄）：

```js
import { renderExtensionTemplateAsync, getContext, extension_settings, saveMetadataDebounced } from '/scripts/extensions.js';
import { saveSettingsDebounced, chat_metadata, eventSource, event_types, ... } from '/script.js';
```

## 2. 数据流（核心资产）

```
.txt/.mobi
  → 分段 chunks（每段 100KB，可调）
  → 清洗（外部 OpenAI 兼容 API）→ 每段产出 JSON：
       { 压缩正文, 剧情节点 nodes[], 角色 chars[] }
  → 阶段划分 stages（一卷/一篇 = 一个开关单位）
  → 向量化（Embedding，每块 1000 字）
  → 每轮聊天：召回 + 直注 + 人设 + 世界 + 文风 + 预告 + 后台动向
  → CHAT_COMPLETION_PROMPT_READY 注入进 chat 数组
```

### 清洗产物的结构（`lib/prompts.js` 里的 JSON schema）
node 关键字段：`title / body / sub_notes[] / branch_links[]（含「【伏笔】xxx」）/ time / location / desc`；
分支泳道由 `main / sub / pivot` 三数组区分（`niMergeStageNodes` 合并成顺序数组）。
角色：`name / aliases / identity / appearance / personality / relations / exitStage / knowledgeByStage ...`（`lib/char-canon.js` 归一）。

## 3. 注入主链：`onPromptReady(eventData)`（`index.js` 5005 行起）

```
cfg.pluginEnabled 检查
↓
① 向量召回      niBuildVectorRecallInputs(plan, chat) → recallRelevantWeighted(...)
                → `[小说原著相关片段·向量召回]…[/…]`
↓
② 阶段直注      niBuildStageInjectionPayloadForPlan(plan, cfg)
                → `[小说剧情节点]…[/…]` 或 `[小说压缩原文]…[/…]`（受 plotInjMaxTokens 约束）
↓
②.5 未来剧情预告 niBuildFuturePlotInjectionPayload(plan, cfg)   ← 默认关闭
↓
②.6 后台动向    niBuildOffscreenInjectionText(cfg)
↓
③ 角色人设      niBuildCharInjectionText(plan)       ← 按「当前阶段」过滤退场/关系/知情
↓
④ 世界设定      niBuildWorldInjectionText(niGetWorldCategories())
↓
⑤ 偏差注入      niLoadDeviationStateFromChat(...)
↓
⑥ 文风          style guide
↓
doInject(key, content, pos, depth, role)
   → eventData.chat 存在：niInsertIntoEventChat(chat, ..., { mergeSystemHead: true })
   → 否则：setExtensionPrompt(key, content, pos, depth, true, role)
```

**最重要的工程结论（README 明确写了）**：`主提示前/后` 不能塞独立 system 消息 —— Claude / Gemini 会合并或丢弃，中转常把 `messages[0]` 当主提示词替换。所以它把内容**并进第一条 system 的文本里**（`niInsertGlobalPromptMessage(..., { preferPrependSystem })`）。

每类内容都有独立的 `{位置, 深度, 角色}`：`vecInjPos/vecInjDepth/vecInjRole`、`charInj*`、`plotInj*`、`worldInj*`、`styleInj*`（默认 `主提示前 / 4`，全局提示词头部 `主提示前 / 0`）。

## 4. 预算与裁剪（`lib/injection-system.js`，纯函数，最好复用）

- `niBuildBoundedStageInjection({ stageIndices, currentStageIdx, maxTokens, getDetailText, getSummaryText })`
  - 阶段按「离当前阶段距离」排序（`niPrioritizeStageIndices`），当前阶段优先；
  - 明细放不下才退到阶段概括，再放不下标记 `omittedStages`；
  - 只在**条目/节点边界**截断（`truncated`），不切半句；
  - 返回 `{ text, selected, detailStages, summaryStages, omittedStages, truncated, estimatedTokens }`。
- 常量：`NI_RAW_INJECTION_MAX_TOKENS_DEFAULT = 32000`、`chunk 1000 字`、`CHARS_PER_TOKEN = 1.5`、全量直注上限 `200000`。
- 向量块：`单轮最多 Token 20000`、`最多召回 30（上限 60）`、`保底召回（及格线不是名额）`、`前情 2 段`。
- **实际取块数 = max(最多召回, 保底召回)**，再按预算逐块裁剪 —— README 专门提醒「预算才是真正的天花板」。

## 5. 穿书模式（`lib/transbook-system.js`）

- `chat[0].ni_tb` 存 `{ curIdx, stages, nodes }`，状态栏挂在聊天结尾。
- 自动推进：`MESSAGE_RECEIVED` → `niBuildAdvanceJudgeMessages` 让模型判定「当前节点演完没」，置信度 ≥ 0.7 才前进；可配「每 1~10 条判一次」。
- 自动跨阶段：本阶段节点走完自动解锁下一阶段。
- 节点注入：当前节点 + 已演节点摘要；`niBuildTbNodeVectorQuery` 用当前节点做召回查询。
- 「进度锚点」（`progressStageIdx / progressNode`）+ 「进度锚点节点」决定「取哪一阶段」「预告从哪开始」。

## 6. 召回屏蔽（很实用的产品细节）

- 屏蔽单位：阶段整段 / 单个剧情节点；**按节点 id 记，不按下标** → 重新解析、重新划分阶段后依然有效。
- 屏蔽同时管住两条路：向量召回不选它，阶段直注/预告也不发它。
- 已知限制（README 自己写清楚）：向量最小单位是按字数切的原文片段，与节点不是一一对应，所以「只屏蔽个别节点」时同块的其它文字仍可能被召回。

## 7. 它的强项 / 短板

**强项**
1. 模块化到 `lib/`，**纯函数可单测**（`tests/` 24 个文件，零依赖 `node tests/run-all.mjs`）。
2. 注入位置 / 深度 / 角色的工程经验非常值钱（并 system、两种注入通道兜底）。
3. 阶段 + 向量 + 预算 + 屏蔽，是一套完整的长篇上下文调度器。
4. 角色 canon（别名 / 多身份 / 退场 / 知情）解决「AI 提前泄底」「死人复活」等真实痛点。
5. 数据体检、失败运行记录、撤销条、注入预览与溯源 —— 可观测性做得比同类好。

**短板**
1. **只「读」原著，不「写」原著**：没有续写工作台，也不给 `generateRaw` 造 prompt。想「自动续写」得另找工具。
2. 清洗产物是「静态原著知识库」，用户/AI 新写出来的正文**不会回流**成知识（只有偏差分析与后台动向旁路记录）。
3. 依赖外部清洗 API 才有内容；纯 TXT 导入不出活。
4. `index.js` 仍有 8k 行装配 + UI 代码，且强绑 `chat_metadata`（chat 维度），一个「书」跨多个对话时不好组织。
