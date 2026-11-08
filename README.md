# 续写工坊 / Fiction Weaver

把 **xu-xie-ji**（分层总结 + 续写工作台）和 **novel-injector-2w**（TXT 清洗 + 分阶段注入）合并成一个 SillyTavern 扩展：
**同一份剧情知识库，既喂给聊天注入，也喂给编辑器续写。**

```
                 ┌──────────── 一份故事知识库（story-scoped）────────────┐
  TXT ──清洗──▶  │ 节点 / 角色 / 世界设定 / 阶段 / 分层总结 / 伏笔     │
                 └───────────────────────┬─────────────────────────────┘
                                         │ fwBuildInjectionBlocks()
                        ┌────────────────┴────────────────┐
                        ▼                                 ▼
             聊天注入（CHAT_COMPLETION_PROMPT_READY）   编辑器续写（generateRaw）
             并进第一条 system，按 token 预算裁剪        同一份记忆 + 草稿尾部
```

## 安装

酒馆的「安装扩展功能」只认 **http(s) 的 git 地址**：它会 `git clone` 到 `extensions/third-party/<仓库名>/`，然后**要求 `manifest.json` 就在仓库根目录**，否则报
`Validation error: Extension manifest.json is missing` 并把目录删掉。
本地这份还没有远端仓库，所以走下面任一条：

**A. 用自带脚本装（推荐，一步到位）**

```bash
node tools/install.mjs /path/to/SillyTavern            # → data/<用户>/extensions/third-party/fiction-weaver
node tools/install.mjs /path/to/SillyTavern --global   # → public/scripts/extensions/third-party/fiction-weaver
node tools/install.mjs /path/to/SillyTavern --dry-run  # 先看看会写哪
```

数据目录下有多个用户时加 `--user <名字>`。然后刷新酒馆页面（Tauri / 手机端重启 App）。

**B. 手动复制**

把 `manifest.json`、`index.js`、`style.css`、`template.html`、`lib/`（这五样缺一不可）放进：

- `SillyTavern/data/<你的用户名>/extensions/third-party/fiction-weaver/`，或
- `SillyTavern/public/scripts/extensions/third-party/fiction-weaver/`

**C. 手机上装**

```bash
node tools/install.mjs --zip          # 产出 fiction-weaver.zip
```

把 zip 传到手机，解压后整个 `fiction-weaver/` 目录放进酒馆的 `extensions/third-party/`，重启 App。

**D. 想用「安装扩展功能」按 URL 装**

得先把这个目录变成一个**根目录就带 `manifest.json`** 的远端仓库：

```bash
git init -b main && git add -A && git commit -m "init"
git remote add origin https://github.com/<你>/fiction-weaver.git
git push -u origin main
```

推完打开 `https://raw.githubusercontent.com/<你>/fiction-weaver/main/manifest.json` 确认能直接看到 JSON —— 能看到，URL 安装就一定不会再报 manifest 缺失。**别把扩展放在仓库的子目录里**（酒馆不支持子目录安装），也别把多个扩展塞进同一个仓库。

> 面板要求：`template.html` 是自己 fetch 的，所以目录名随意；酒馆扩展列表里出现不了时，去「管理扩展」看它是不是被禁用了。

## 用法（首次跑通一遍）

> 详细图文版（每个控件逐条讲、常见问题、花费估算）：**[`docs/04-使用手册.md`](docs/04-使用手册.md)**
>
> 界面是两层：酒馆扩展抽屉里只有一张**入口卡片**（一个「打开工作台」按钮 + 两行状态），
> 点开是一个**全屏工作台**（左侧 6 个分页：书库 / 清洗 / 注入 / 进度 / 续写 / 说明），手机上自动铺满整屏。

1. **① 书库**：导入一个 TXT（会按「分段大小」默认 60000 字切段，并识别章节）。
2. **② 清洗**：填 OpenAI 兼容的 `.../v1/chat/completions`、Key、模型名（清洗、总结、润色共用这一套）→ 点「开始清洗」，
   逐段抽取剧情节点 / 角色 / 世界设定 / 压缩正文。可随时停止；失败的分段会被记录，下次点「开始清洗」自动补跑。
3. **③ 注入**：先点「预览本轮注入」看不注入。确认后再聊——注入会自动进行（可取消顶部「启用注入」）。
4. **④ 进度**：用「推进一个节点」告诉它你演到哪了；未来的节点默认不注入，勾选「注入下一个剧情节点」才会当预告（算剧透）。
5. **⑤ 续写**：草稿为空时用最后一条 AI 消息作上下文；「AI 续写」出 1~3 个分支，「追加到草稿」改稿，「填入输入框」交给你自己发送。
6. **① 导出全部**：把书库备份成 JSON，换机器/换浏览器可再导入。

### 两个刻意的设计

- **注入合并进第一条 system，不塞独立 system 消息。** Claude / Gemini 对「多条 system」或「system 出现在中间」经常报错或忽略，合并最稳。
- **书存在 localStorage，跟书走；跟聊天走的只有进度指针 `chat_metadata.fw.progress`。** 一本书可以跨多个对话，换对话不会丢知识库。

## 目录结构

| 路径 | 作用 |
| --- | --- |
| `manifest.json` | 扩展清单（`js` / `css`） |
| `index.js` | **唯一**碰酒馆 API 的装配层：设置持久化、事件钩子、`generateRaw`、面板绑定、工作台开关与分页 |
| `template.html` / `style.css` | 界面结构（抽屉入口卡片 + 全屏工作台 6 个分页）与样式（只作用于 `.fw-` 前缀） |
| `lib/text.js` | 纯文本工具：切段、章节识别、`fwTakeTail`、token 估算 |
| `lib/kb.js` | 故事数据模型：建书、导入、解析/合并清洗结果、统计 |
| `lib/injection.js` | 注入块组装、token 预算裁剪、注入位置、续写 prompt、分支解析 |
| `lib/prompts.js` | 清洗 / 总结 / 润色的 prompt 模板 |
| `lib/clean-api.js` | OpenAI 兼容 HTTP 调用（超时、错误信息） |
| `lib/store.js` | localStorage 读写、导入导出 |
| `docs/` | 两个上游的分析 + 合并架构 + **`04-使用手册.md`（给使用者看的逐控件说明/FAQ）** |
| `tools/install.mjs` | 安装 / 打包工具（`--global` / `--user` / `--dry-run` / `--zip`），零依赖，带自检 |
| `tests/` | 零依赖测试（纯函数单测 + 契约扫描 + 假 DOM 冒烟），含 `_dom.mjs` / `_stubs/` |

**架构铁律：`lib/` 里不许 import 酒馆模块**，所有可测逻辑都是纯函数；`index.js` 只做接线。`tests/wiring.test.mjs` 会守住这条。

## 开发与测试

```powershell
node tests/run-all.mjs          # 全量（零依赖，串行，退出码即门禁）
node tests/run-all.mjs kb inj   # 只跑文件名含关键字的
```

8 个测试文件、306 条断言：

| 文件 | 管什么 |
| --- | --- |
| `text.test.mjs` | 切段（不切半句）、章节识别、边界截断、关键词命中 |
| `kb.test.mjs` | 建书/导入、JSON 抠取、清洗结果解析与合并、伏笔、统计 |
| `injection.test.mjs` | 注入块优先级、token 预算裁剪、并进 system、续写 prompt、分支切分 |
| `clean-api.test.mjs` | 端点补全、请求头、响应文本提取 |
| `ui-contract.test.mjs` | 模板 `fw-*` id ↔ 代码引用、设置项双向同步、**分页契约（`fw-nav-x` ↔ `fw-pane-x` ↔ `FW_PANES`）**、manifest 字段 |
| `wiring.test.mjs` | import 都能解析到真实导出、`lib/` 不依赖酒馆、关键函数不重复定义 |
| `smoke.test.mjs` | **假 DOM 把 `index.js` 真跑一遍**：开/关工作台 → 切分页 → 建书 → 导入 → 清洗 → 预览 → 注入 → 推进度 → 续写 → 润色 → 落盘 → 导出 |
| `tools.test.mjs` | 安装包该带哪些文件（缺一个就报 manifest 缺失）、zip 结构/CRC32、`--global`/`--user` 落点推导 |

`tests/_dom.mjs` 是最小假 DOM，`tests/_stubs/` 是酒馆模块桩子 —— 它们只服务于 `smoke.test.mjs`，测试时会临时生成一份把酒馆 import 换成桩子的 `index.js` 副本再 import（跑完即删）。

## 已知限制（v0.2）

- **没有 LICENSE。** 两个上游仓库都未提供许可证，本仓库在选定许可前不要公开发布（详见 `docs/03-merged-architecture.md`）。
- 只有「逐段清洗」这一条路，尚未接入向量检索（里程碑 M5）；当前靠预算裁剪 + 阶段过滤控制注入量。
- **M4 记忆闭环未接**：写出来的新正文不会自动回流成节点/总结，需要手动再导入一次（`docs/04-使用手册.md` Q13）。
- 续写走 `generateRaw`，需要较新的酒馆版本（会先检测，没有就提示而不是报错）。
- 润色 / 清洗失败只提示，不重试；重跑靠「开始清洗」补齐未完成的分段。
- 没有编辑节点 / 角色 / 世界设定的界面（只能导出 JSON 改完再导入）。
