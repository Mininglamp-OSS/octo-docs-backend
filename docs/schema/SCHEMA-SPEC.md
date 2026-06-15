# `@octo/docs-schema` SCHEMA SPEC（单一版本规格源 / Single Source of Truth）

> 维护：PM（托马斯）｜本文件是 ProseMirror schema 的**唯一权威版本规格**。
> 现阶段前后端各自的 `src/schema/index.ts` 是本 spec 的**本地镜像 stub**（仓库已拆分，暂不引真 npm 包）。
> 任何 schema 变更（新增/修改 node 或 mark）**必须**：① 先在群里 @PM 报「要加什么」② PM 在此 spec 升版并分配 SCHEMA_VERSION ③ 前后端 stub 同步改到与本 spec 一致 ④ PR 描述引用本 spec 版本号。
> 双引擎 review 增加一道 schema 一致性检查：前后端 stub 的 node/mark 集合 + 版本号必须与本 spec 一致，否则 Request Changes。
> 契约依据：frontend §9.1/§9.2（SCHEMA_VERSION 定义）+ backend §7.1（冻结包 / schema 不匹配 → Agent 写回丢数据）。

---

## 版本台账

### SCHEMA_VERSION = 1（基线，已在 main）
对应当前 f460b49 前端实际能力 + backend 7e1e7f4 stub。

**Nodes**：`doc`、`paragraph`、`heading`（level 1–6）、`text`、`bulletList`、`orderedList`、`listItem`、`taskList`、`taskItem`、`blockquote`、`codeBlock`、`horizontalRule`
**Marks**：`bold`、`italic`、`strike`、`code`、`link`（href 白名单 http/https/mailto）

> 注：H3–H6 已在 schema（heading levels=[1..6]），PR #1 仅补 UI 入口，**不升版**。

---

### SCHEMA_VERSION = 2（分配给：Boris / P1b 图片 image node）🟢 已发号·已提 PR #2
**变更类型**：新增 1 个 node。
**新增 Node**：
- `image`（block 或 inline，按前端 NodeView 定）— attrs: `{ attachId, src, alt, title, width, align }`；**红线：src 严禁 base64 入 Y.Doc,只存 attachId + presign 换发的 URL**（backend §3.5）
**前端 stub**：`SCHEMA_VERSION = 2` + nodes 加 `image`（NodeView 实现 alt/缩放/对齐）
**后端 stub**：`buildSchema()` nodes 加 `image` + bump `SCHEMA_VERSION = 2`；Agent 写回须认识 image node 否则丢内容
**依赖**：后端 §3.5 presign 端点 + §3.4 doc_attachment 表
**关联 PR**：后端 `feat/p1b-attachments-presign`（Boris，PR #2 已提）+ 前端 image NodeView（Ploy，待提）

> 发号调整说明：image 原拟 v3、highlight/color 原拟 v2。因 Boris image PR 先落地、highlight/color 尚未开 PR，按「落 main 线性顺序」改为 image=2、highlight/color=3，避免 Boris 返工。版本号累加：v3 须含 v2 的 image node。

---

### SCHEMA_VERSION = 3（分配给：Ploy / P1a 高亮+颜色）🟢 已发号
**变更类型**：新增 2 个 mark，无新 node。
**新增 Marks**：
- `highlight`（`@tiptap/extension-highlight`，multicolor）— attrs: `{ color }`；parseDOM `<mark>`；toDOM `<mark style="background-color:...">`
- `textStyle`（`@tiptap/extension-text-style`）— 作为 `color`（`@tiptap/extension-color`）的载体；attrs: `{ color }`；parseDOM/toDOM `<span style="color:...">`

> `@tiptap/extension-color` 不新增 node/mark，仅给 `textStyle` 挂 `color` attr。
**前端 stub**：`SCHEMA_VERSION = 3` + marks 加 `highlight`、`textStyle`（**累加保留 v2 的 image node**）
**后端 stub**：`buildSchema()` marks 加 `highlight`、`textStyle`（toDOM/parseDOM 与前端字节对齐，**累加保留 image node**）+ `SCHEMA_VERSION = 3`
**关联 PR**：前端 `feat/text-highlight-color`（待提）；后端同步适配

---

### SCHEMA_VERSION = 4+（预留：表格 / callout / toggle）
- 表格 `table`/`tableRow`/`tableCell`/`tableHeader`（Ploy P1a，工作量最大，单独报号）
- Callout / Toggle（P2，报号时分配）

---

## 升版操作清单（每次改 schema 照做）
1. @PM 报要加的 node/mark + attrs + parseDOM/toDOM
2. PM 在本 spec 加版本段 + 分配号 + push 更新
3. 前端 stub `src/schema/index.ts`：bump `SCHEMA_VERSION` + 改 nodes/marks
4. 后端 stub `src/schema/index.ts`：bump `SCHEMA_VERSION` + `buildSchema()` 同步
5. 两端 toDOM/parseDOM **字节对齐**（schema drift = Agent 写回 corruption）
6. PR 描述写明「SCHEMA_VERSION N，对应 SCHEMA-SPEC.md 第 N 段」
7. 双引擎 review 核两端一致性 + 版本号对齐
