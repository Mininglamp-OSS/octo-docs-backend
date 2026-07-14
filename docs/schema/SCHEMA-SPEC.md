# SCHEMA-SPEC — octo-docs collaboration schema versioning governance

## 目的与锁步原则

- 本文是协同 schema 的 `SCHEMA_VERSION` 发号**权威登记表**，与前端 `@octo/docs-schema`（Tiptap 配置）保持锁步。服务端 schema（`src/schema/index.ts` 的 `buildSchema()`）与前端的 node/mark 集合**必须在同一 version 下定义同一套类型**，否则 Y.Doc ↔ ProseMirror 转换会丢失或损坏内容。`SCHEMA_VERSION` 常量见 `src/schema/index.ts:67`；锁步要求见该文件头注释。
- **单调递增、不跳号**；砍掉的号**作废留空、不回收**（留作 gap）。落地时按 PM 发号顺序**逐项 bump**；最终 `SCHEMA_VERSION` = **实际合入的最高号**，见 `src/schema/index.ts` 文件头注释。
- 后端**不自行发号**：登记的号与前端使用的号完全一致。

## 已注册版本历史（已合入，真实代码）

下列为已合入 `buildSchema()` 的累积历史（vN ⊇ v(N-1)，纯增量，不删除既有类型）。

| version | 新增 node / mark | 状态 | 代码引用 |
| --- | --- | --- | --- |
| v1 | 基础 schema：`doc` / `paragraph` / `heading` / `text` 节点 + `bold` / `italic` marks | shipped | `src/schema/index.ts:130-144`、`233-239` |
| v2 | `image` 节点（仅存引用 `attachId` / 受控 `src`，绝不内联 base64） | shipped | `src/schema/index.ts:150-192`；version 缘由 `src/schema/index.ts:24-26` |
| v3 | `highlight` + `textStyle` marks | shipped | `src/schema/index.ts:248-289`；缘由 `src/schema/index.ts:27-28` |
| v4 | 四个表格节点 `table` / `tableRow` / `tableCell` / `tableHeader`（byte-aligned 到 prosemirror-tables / `@tiptap/extension-table` 2.27.2） | shipped | `src/schema/index.ts`；缘由见文件头注释 |
| v5 | `textAlign` ATTR（heading / paragraph，非新 node/mark） | shipped | 前端 Tiptap `@tiptap/extension-text-align`；后端 attr 透传 |
| v6 | `underline` mark | shipped | `src/schema/index.ts`（marks 段） |
| v7 | `fontSize` ATTR（挂在 `textStyle` mark 上，非新 mark） | shipped | `src/schema/index.ts`（`textStyle` 同时携带 `color` v3 + `fontSize` v7） |
| v8 | `superscript` + `subscript` marks（一并落地） | shipped | `src/schema/index.ts`（marks 段） |
| v9 | `emoji` inline 节点（attr `name`；**NON-atom**——内容为空的 inline leaf，dump 中 `atom:false`；toDOM 为 `span[data-type=emoji][data-name]` + 字面 `:${name}:` 文本子节点） | shipped | `src/schema/index.ts`（nodes 段） |
| v10 | `mention` inline atom 节点（attrs id / label / **mentionSuggestionChar**（默认 `"@"`）/ type（默认 `"user"`）；`data-mention-suggestion-char` + `data-mention-type` round-trip，span 带 `octo-mention` class） | shipped | `src/schema/index.ts`（nodes 段） |
| v11 | 可折叠 `details` 块（`details` > `detailsSummary` + `detailsContent`） | shipped | `src/schema/index.ts`（nodes 段） |
| v12 | 自建 `callout` 块（attr `variant` info/warn/tip/success；`data-variant` round-trip） | shipped | `src/schema/index.ts`（nodes 段）；前端 `Callout.ts` |
| v13 | `inlineMath` + `blockMath` 节点（attr `latex`） | shipped | `src/schema/index.ts`（nodes 段） |
| v14 | 自建 `fileAttachment` 块 atom（attrs attachId/fileName/mime/sizeBytes；data-attach-id/data-file-name/data-mime/data-size-bytes round-trip） | shipped | `src/schema/index.ts`（nodes 段）；前端 `FileAttachment.ts` |
| v15 | 自建 `bookmark` 块 atom（attrs url/title/description/image/siteName/fetchedAt；data-url/data-title/data-description/data-image/data-site-name/data-fetched-at round-trip） | shipped | `src/schema/index.ts`（nodes 段）；前端 `Bookmark.ts` |
| v16 | `fontFamily` ATTR（挂在 `textStyle` mark 上，非新 mark；复刻 v7 fontSize 路径——挂 inline `style="font-family:…"`，`textStyle` 现同时携带 `color` v3 + `fontSize` v7 + `fontFamily` v16） | shipped | `src/schema/index.ts`（`textStyle` marks 段） |

当前 `SCHEMA_VERSION = 16`（`src/schema/index.ts`）—— v5–v15 已与前端 `@octo/docs-schema` **原子同落**；v16 为本次「正文字体」特性的前后端共享契约（发号钉死、不横跳），后端 `buildSchema()` 在 `textStyle` mark 上新增 `fontFamily` attr，前端 `@octo/docs-schema` 半边注册**同一号**。

### byte-align 校正（对齐前端 `getSchema()` dump，schemaVersion=15 / tiptap 3.22.2）

后端 `buildSchema()` 早期若干节点按 Tiptap 默认猜测实现，与前端 dump 存在 drift；已按 dump **逐字节对齐**（attr 集合 + 默认值优先，toDOM 次之但一并对齐）：

- **paragraph / heading**：新增 `textAlign` attr（默认 `null`，挂 inline `style="text-align:…"`）——v5 之前后端漏挂。
- **emoji**：由 `atom:true` 改为 **NON-atom** inline leaf，toDOM 增加 `:${name}:` 文本子节点。
- **mention**：补 `mentionSuggestionChar` attr（默认 `"@"`，`data-mention-suggestion-char`）+ `octo-mention` class；`type` 默认 `"user"`。
- **link** mark：`rel` 默认由 `"noopener noreferrer nofollow"` 校正为 **`"noopener noreferrer"`**；补 `title` attr；`inclusive` 由 `false` 改为 **`true`**（dump 为 inclusive）。
- **code** mark：补 `excludes: "_"`（dump 中 code 排斥所有其他 mark）。
- **table cell / header**：`cellAttrs` 补 `align` attr（默认 `null`，`data-align` 仅非空时序列化）。
- **hardBreak**：新增 inline `<br>` leaf 节点（dump 含 hardBreak，原后端缺失）。
- **lists**：`bulletList` / `orderedList` / `taskList` 的 group 由 `"block"` 校正为 **`"block list"`**；`tableRow` content 由 `+` 校正为 `*`。
- **details**：toDOM 补 `octo-details` class；`detailsSummary` content 由 `inline*` 校正为 `text*`。
- **inlineMath / blockMath**：`data-type` 为 `inline-math` / `block-math`，`latex` 默认空串——已对齐。


## PM 冻结发号表（batch 3，已落地）

PM 的单一权威发号表如下。5–13 由前端（Ploy）落地，14 / 15 为后端（Boris）拥有的 node-attr 契约。**全部已合入**（v15 原子同落）。

| 号 | 项 | 新增 schema 类型 | 归属 | 状态 |
| --- | --- | --- | --- | --- |
| 5 | textAlign | mark/attr（前端 Tiptap） | 前端 Ploy | landed |
| 6 | underline | mark | 前端 Ploy | landed |
| 7 | fontSize | mark/attr | 前端 Ploy | landed |
| 8 | superscript + subscript | marks | 前端 Ploy | landed |
| 9 | emoji | node | 前端 Ploy | landed |
| 10 | mention | node | 前端 Ploy | landed |
| 11 | details（`details` / `detailsSummary` / `detailsContent`） | nodes | 前端 Ploy | landed |
| 12 | callout | node | 前端 Ploy | landed |
| 13 | math（KaTeX） | node | 前端 Ploy | landed |
| 14 | **fileAttachment** | **node（后端拥有 attr 契约）** | **后端 Boris** | landed |
| 15 | **bookmark** | **node（后端拥有 attr 契约）** | **后端 Boris** | landed |
| 16 | fontFamily | mark/attr（挂 `textStyle`，复刻 v7 fontSize） | 前后端共享契约 | landed |

发号冻结依据见 `src/schema/index.ts` 文件头注释。

## 后端拥有的节点契约（14 / 15）

后端定义这两个节点的 attr 契约，前端 Tiptap 节点**必须逐字 byte-align**（属性名 verbatim，**不得发明别名**）。依据 `src/schema/index.ts:48-63`。

### 14 · `fileAttachment` node

- **attrs**：`attachId` (string)、`fileName` (string)、`mime` (string)、`sizeBytes` (number)。
- 该节点**只引用** `doc_attachment` 行，**不内联字节**，与现有 `image` 节点用 `attachId` 引用附件的方式一致（`image` 节点见 `src/schema/index.ts:150-192`）。
- 对应 `doc_attachment` 表列（`migrations/schema.sql:123-134`）：`attach_id` → `attachId`、`mime` → `mime`、`size_bytes` → `sizeBytes`；`file_name` 列于 batch3 新增（`migrations/schema.sql:129`，`VARCHAR(512) NOT NULL DEFAULT ''`，已 sanitize 的原始文件名，用于下载 `Content-Disposition`）→ `fileName`。

### 15 · `bookmark` node

- **attrs**：`url`、`title`、`description`、`image`、`siteName`、`fetchedAt`。
- 该 attr 集合**严格等于** link-card OG 接口的出参：`POST /docs/:docId/link-card` 返回 `{ url, title, description, image, siteName, fetchedAt }`。
- 出参契约（fixed / frontend-locked）见 `src/util/ogFetch.ts:22-30`（`interface OgCard`）与产出处 `src/util/ogFetch.ts:289-297`（`parseOgCard` 返回）；路由处理见 `src/api/routes/linkCard.ts:48-86`。
- 前端 `bookmark` 节点必须沿用以上 6 个字段名作为 attrs，verbatim 对齐，无别名。

## 当前状态与落地协议

- `SCHEMA_VERSION` **当前 = 16**（`src/schema/index.ts`）。v5–v15 已与前端 `@octo/docs-schema` **原子同落**：前后端在同一时刻都到达 15，`buildSchema()` 现已定义完整 node/mark 集合（lists/taskList/blockquote/codeBlock/horizontalRule + emoji/mention/details/callout/inlineMath/blockMath + fileAttachment/bookmark，marks 含 underline/superscript/subscript，`textStyle` 携带 color+fontSize）。**v16** 在 `textStyle` mark 上新增 `fontFamily` attr（复刻 v7 fontSize 路径），为「正文字体」特性的前后端共享契约，发号钉死不横跳。
- 14 / 15 的 attr 契约（后端拥有）见上「后端拥有的节点契约」；前端 `FileAttachment.ts` / `Bookmark.ts` / `Callout.ts` 已逐字 byte-align。
- batch3 后端工作（附件 presign 白名单放开 + link-card OG 接口）与 schema 解耦、先行实现：link-card 路由见 `src/api/routes/linkCard.ts`，安全出站抓取见 `src/util/ogFetch.ts`（SSRF 防护见 `src/util/ssrfGuard.ts`）。
- 后续 bump（v16+）时的同步动作：
  1. `buildSchema()` 累加对应新节点（attr 契约 byte 对齐）；
  2. `SCHEMA_VERSION++`（单调递增、不跳号、不回收）；
  3. 本表对应行状态补「已注册版本历史」表；
  4. 前端 `@octo/docs-schema` 同步注册，node / attr **byte 对齐**。
