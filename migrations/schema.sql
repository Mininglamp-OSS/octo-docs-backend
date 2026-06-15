-- Octo Docs collaborative document backend — database schema (§3.4)
--
-- This file copies the table DDLs EXACTLY from the FROZEN contract
-- (docs/contract/backend-design.md §3.4, MySQL 8 dialect).
--
-- Run order: doc_meta first (referenced by others conceptually, no hard FKs
-- per contract), then member/invite/redemption, then the Y.Doc binary tables.
--
-- Usage:
--   mysql -u <user> -p <database> < migrations/schema.sql
--
-- Tables:
--   doc_meta              business metadata (title/owner/space/folder/epoch)
--   doc_member            document-autonomous membership (reader/writer/admin)
--   doc_invite            link invites
--   doc_invite_redemption invite redemption ledger (idempotency / audit)
--   yjs_document          Y.Doc binary authoritative state (single merged row)
--   yjs_snapshot          OPTIONAL baseline snapshot (incremental-log model only)
--   yjs_update_log        OPTIONAL incremental log (incremental-log model only)
--   doc_attachment        OPTIONAL attachment reference table (§3.5)

-- 文档元数据（业务库）
CREATE TABLE doc_meta (
  doc_id        VARCHAR(64)  NOT NULL,            -- 业务主键（如 d_abc123），由创建 API 生成
  document_name VARCHAR(256) NOT NULL,            -- 规范持久化/路由键 octo:{space}:{folder}:{doc}
  title         VARCHAR(512) NOT NULL DEFAULT '',
  owner_id      VARCHAR(64)  NOT NULL,            -- 创建者 / 拥有者（Octo user id），隐含 admin（见 §4.2）
  space_id      VARCHAR(64)  NOT NULL,            -- 所属 docs 空间（documentName 第 2 段 {space}），多租隔离维度
  folder_id     VARCHAR(64)  NOT NULL DEFAULT 'f_default', -- docs 原生文件夹（documentName 第 3 段 {folder}）；v2.0：不再是 octo group_no，仅做组织/归类，不派生权限（见 §4 / §8.1）。**非空保留默认值 `f_default`**（省略 folderId 的新建文档归此保留文件夹）；**documentName 第 3 段必须等于本列值**（键与 folder_id 恒一致，见 §8.1）
  doc_type      VARCHAR(32)  NOT NULL DEFAULT 'doc', -- doc / template ...
  status        TINYINT      NOT NULL DEFAULT 1,  -- 1=正常 0=已删除(软删) 2=归档
  permission_epoch BIGINT    NOT NULL DEFAULT 0,   -- 权限版本号（单调递增，权威落 DB；v2.0 按 doc_member 变更 +1，见 §4.5）
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  created_by    VARCHAR(64)  NOT NULL,
  updated_by    VARCHAR(64)  NOT NULL DEFAULT '',
  PRIMARY KEY (doc_id),
  UNIQUE KEY uk_document_name (document_name),    -- document_name 全局唯一
  KEY idx_space (space_id, status, updated_at),
  KEY idx_folder (folder_id, status, updated_at),
  KEY idx_owner (owner_id, status, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 文档自治成员（v2.0 新增，替代 v1.x 的 doc_acl —— 见下方迁移说明）
-- 把 uid 按 role 直接授到某 doc；resolveRole 仅查此表 + owner（§4.2），不再做 octo 群继承。
CREATE TABLE doc_member (
  doc_id        VARCHAR(64)  NOT NULL,            -- 关联 doc_meta.doc_id
  uid           VARCHAR(64)  NOT NULL,            -- 被授权的 Octo user id（可信 uid，来源见 §4.4 / §4.6）
  role          TINYINT      NOT NULL,            -- 1=reader 2=writer 3=admin
  granted_by    VARCHAR(64)  NOT NULL,            -- 授权人 uid（直接添加为 owner/admin；链接邀请为 doc_invite.created_by）
  source        TINYINT      NOT NULL DEFAULT 1,  -- 1=direct(直接添加) 2=invite(经 doc_invite 接受)
  invite_token  VARCHAR(64)  NOT NULL DEFAULT '', -- 经邀请加入时记录来源 token（审计/回收），direct 为空
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (doc_id, uid),                      -- 一个 uid 对一个 doc 至多一行（role 升降走 UPDATE）
  KEY idx_uid (uid, role),                        -- 「我能访问哪些 doc」列表页/反查
  KEY idx_doc_role (doc_id, role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 链接邀请（v2.0 新增）：一个 token 携带授予 role，仅【已注册 octo 用户】可接受（见 §4.6 接受流程）。
CREATE TABLE doc_invite (
  invite_token  VARCHAR(64)  NOT NULL,            -- 邀请 token（高熵随机串，进 URL）
  doc_id        VARCHAR(64)  NOT NULL,            -- 关联 doc_meta.doc_id
  role          TINYINT      NOT NULL DEFAULT 2,  -- 授予 role：1=reader 2=writer(默认) 3=admin
  max_uses      INT          NOT NULL DEFAULT 0,  -- 最大可用次数；0 表示不限次（按 expires_at 控制）
  used_count    INT          NOT NULL DEFAULT 0,  -- 已被接受次数（每成功 accept +1，原子自增并校验上限）
  expires_at    DATETIME(3)  NULL,                -- 过期时间；NULL 表示不过期（仍可被 revoke）
  status        TINYINT      NOT NULL DEFAULT 1,  -- 1=active 0=revoked 2=exhausted(用尽) 3=expired
  created_by    VARCHAR(64)  NOT NULL,            -- 创建邀请的 uid（须对该 doc 具 admin）
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (invite_token),
  KEY idx_doc (doc_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 可选：邀请接受流水（幂等去重 + 审计；防同一 uid 重复消耗 used_count）。
CREATE TABLE doc_invite_redemption (
  invite_token  VARCHAR(64)  NOT NULL,
  uid           VARCHAR(64)  NOT NULL,            -- 接受邀请的可信 uid
  redeemed_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (invite_token, uid)                 -- 同一 uid 对同一 token 仅计一次（再次点击不重复 +used_count）
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 【迁移说明：doc_acl → doc_member】
-- v1.x 的 doc_acl(principal_type ∈ {1=user, 2=group}) 在 v2.0 被 doc_member 取代：
--   · principal_type=user 行 = 直授个人 → 直接迁入 doc_member（doc_id, principal_id→uid, role, granted_by, source=direct）；
--   · principal_type=group 行 = 群授权/群继承 → 「群=权限」语义被产品决策删除，这类行【丢弃】（不再迁移）。
-- 迁移期需对受影响文档逐一确认 owner/admin 已落 doc_member，避免删除群继承后无人可管理（见 §4.2 迁移注意）。

-- Y.Doc 二进制权威态（与元数据分离；主模型：单行权威合并态）
CREATE TABLE yjs_document (
  id            BIGINT       NOT NULL AUTO_INCREMENT,
  document_name VARCHAR(256) NOT NULL,            -- Hocuspocus 路由/持久化键，非 doc_id
  state         LONGBLOB     NOT NULL,            -- Y.encodeStateAsUpdate 结果（并集合并态）
  size_bytes    INT          NOT NULL DEFAULT 0,
  updated_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_document_name (document_name)     -- 每文档单行，store 走 UPSERT + merge-on-write
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 可选：基线 snapshot（仅「增量日志」备选模型启用时建；与上表二选一作真相源，见 §3.3）
CREATE TABLE yjs_snapshot (
  document_name VARCHAR(256) NOT NULL,            -- 与 yjs_update_log 同键
  state         LONGBLOB     NOT NULL,            -- 基线完整态
  captured_seq  BIGINT       NOT NULL,            -- 已重放进本基线的最大 update_log.seq
  size_bytes    INT          NOT NULL DEFAULT 0,
  updated_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (document_name)                     -- 每文档单行基线
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 可选：增量日志（仅「增量日志」备选模型启用时建，见 §3.3）
CREATE TABLE yjs_update_log (
  seq           BIGINT       NOT NULL AUTO_INCREMENT, -- 单一权威分配（DB 自增），禁止应用层 MAX+1
  document_name VARCHAR(256) NOT NULL,
  update_bin    BLOB         NOT NULL,            -- 单条增量 update
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (seq),
  KEY idx_doc_seq (document_name, seq)            -- compact 用 seq <= captured_seq 截断
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 可选：附件引用表（见 3.5）
CREATE TABLE doc_attachment (
  attach_id     VARCHAR(64)  NOT NULL,
  doc_id        VARCHAR(64)  NOT NULL,
  object_key    VARCHAR(1024) NOT NULL,           -- 对象存储 key
  mime          VARCHAR(128) NOT NULL,
  size_bytes    BIGINT       NOT NULL,
  created_by    VARCHAR(64)  NOT NULL,
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (attach_id),
  KEY idx_doc (doc_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
