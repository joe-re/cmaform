<h1 align="center">cmaform</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/cmaform"><img src="https://img.shields.io/npm/v/cmaform.svg" alt="npm version"></a>
  <a href="https://github.com/joe-re/cmaform/actions/workflows/ci.yml"><img src="https://github.com/joe-re/cmaform/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/npm/l/cmaform.svg" alt="License: MIT"></a>
</p>

<p align="center">
  <a href="./README.md">English</a> | 日本語
</p>

**cmaform** は **Anthropic Managed Agents / Skills / Memory Stores** を Terraform 風のワークフローで declarative に管理する CLI です。1 リソース = 1 ファイル (YAML / SKILL.md / manifest.yaml) で git にコミットでき、`cmaform plan` で差分を確認、`cmaform apply` で適用します。

```text
  [~] update agent  "release-prep" (id=agent_01Qx..., version=6)
       file: agents/release-prep.yaml
       ~ system:
           ... (12 unchanged lines)
         - 既存ロジック...
         + 改修ロジック...
           ... (8 unchanged lines)
  [+] create skill  "spec-lookup"
       dir:  skills/spec-lookup
       hash: 7b8b14094e01...

Plan (agents):        0 to add, 1 to change, 0 to archive, 5 unchanged.
Plan (skills):        1 to add, 0 to change, 0 to delete, 0 unchanged.
Plan (memory_stores): 0 to add, 0 to change, 0 to archive, 0 unchanged.
```

## ⚡ クイックスタート

まず試す

```bash
npx cmaform --help
```

インストールして使う

```bash
npm install -g cmaform
```

構成ディレクトリを作って、既存の managed agent を取り込む

```bash
export ANTHROPIC_API_KEY=sk-ant-...

mkdir my-agents && cd my-agents
cmaform pull agent_011CaSWcCrMdQdp4SA6TVdH6   # agents/<name>.yaml と state を生成
cmaform plan                                  # 差分確認
cmaform apply                                 # 確認 → Anthropic に反映
```

> Anthropic の Managed Agent / Skills / Memory Stores API は現時点で **beta** です。cmaform は内部で `@anthropic-ai/sdk` の `beta.agents.*` / `beta.skills.*` / `beta.memoryStores.*` を直接呼びます。

## 🚀 使い方

### コマンド一覧

| コマンド | 説明 |
| --- | --- |
| `cmaform pull <id>` | `agent_*` / `skill_*` / `memstore_*` ID から remote → local / state に取り込む |
| `cmaform plan [target...]` | local YAML / state / remote の差分を Terraform 風に表示 |
| `cmaform apply [--yes\|-y] [target...]` | plan を表示 → 確認 → 適用 → state 保存 |
| `cmaform sync` | state にある全 entry を remote から取り直し YAML を再生成 |
| `cmaform init` | state ファイルを remote の現状に合わせて初期化 / 同期 (remote 書き込みなし、`terraform init` 相当) |
| `cmaform list` | local files / state / remote を並べて表示 |

### plan / apply の絞り込み

`plan` / `apply` の末尾に target を渡すと対象を絞り込めます。target には **リソース種別** と **個別リソース名** の両方を指定できます (例: skill を先に作って `skill_id` を採番してから、その ID を埋め込んだ agent YAML を apply する、といった段階デプロイに便利)。

```bash
cmaform apply skills                     # skill だけ全部 apply
cmaform apply agents                     # agent だけ全部 apply
cmaform apply slack-mention-lookup       # skill 1 件だけ
cmaform apply release-prep --yes         # agent 1 件だけ (確認スキップ)
cmaform apply skills release-prep        # 全 skill + release-prep agent
```

種別の別名: `agent` / `agents` / `skill` / `skills` / `memory_store` / `memory_stores` / `memstore` / `memstores`。

個別名を指定して local YAML / state / remote のどこにも見つからない場合は exit code `2` でエラー終了します。種別を指定して該当 0 件の場合はエラーになりません (`0 to add, 0 to change, ...` と出るだけ)。

### 既存リソースの取り込み

```bash
cmaform pull agent_011CaSWcCrMdQdp4SA6TVdH6   # agents/<name>.yaml を生成
cmaform pull skill_013uPS15B3Kw82NpjH4uNQep   # state のみ更新 (SKILL.md は再生成しない)
cmaform pull memstore_01ABC...                # memory_stores/<name>/manifest.yaml を生成
```

Skill 本体ファイル (`SKILL.md` 等) は **API が content を返さない**ため、`pull` でも復元できません。state には ID / version / display_title だけが記録され、ローカルファイルは自分で書く必要があります。

## 📦 リソース

cmaform は 3 種類のリソースを管理します。各々が構成ルートのサブディレクトリに置かれます。

### Agent (`agents/<name>.yaml`)

```yaml
name: my-agent              # workspace 内で一意。これが識別キー
model:
  id: claude-sonnet-4-6
  speed: standard           # standard | fast
description: 短い説明
system: |-
  ... system prompt 全文 ...
mcp_servers:
  - name: slack
    type: url
    url: https://mcp.slack.com/mcp
tools:
  - type: agent_toolset_20260401
    default_config:
      enabled: true
      permission_policy:
        type: always_allow
    configs: []
skills: []
metadata: {}
```

- **識別**: `name` フィールド。`agent_id` は YAML に書かず state で管理
- **差分検出**: `name` / `model` / `description` / `system` / `tools` / `mcp_servers` / `skills` / `multiagent` / `metadata` を deep equal で比較
- **削除**: state にあるが local YAML にない name → `archive` (取り戻せる)
- 配列 (`tools` / `mcp_servers` / `skills`) は **完全置換**。local が真実

スキーマの詳細は [Anthropic Agent Setup ドキュメント](https://platform.claude.com/docs/en/managed-agents/agent-setup) を参照。

### Skill (`skills/<localName>/`)

Skill は **ディレクトリ単位**で管理します。Anthropic API は `SKILL.md` を含むフォルダ全体を 1 つの zip として扱います。

```
skills/<localName>/
├── SKILL.md            # 必須 (YAML frontmatter + markdown 本文)
├── REFERENCE.md        # 任意
└── scripts/
    └── helper.py       # 任意
```

`SKILL.md` の冒頭に frontmatter が必須:

```markdown
---
name: my-skill
description: 何をする skill で、いつ Claude が使うべきか
---

# My Skill
...
```

- `name`: 64 文字以下、`[a-z0-9-]` のみ。`anthropic` / `claude` は予約語
- `description`: 1024 文字以下

cmaform はディレクトリ配下の全ファイルから SHA-256 ハッシュを計算し、state に記録した hash と比較して差分を検出します。差分があれば `apply` で **新 version をアップロード**します。

#### Agent YAML から skill を参照する

```yaml
# agents/foo.yaml
skills:
  - type: anthropic
    skill_id: xlsx
  - type: custom
    skill_id: skill_01XXXXXX         # apply 後に state.skills[<localName>].id を見て転記
    version: latest
```

> ⚠️ Skill には archive 概念がありません。ディレクトリを消して `apply` を実行すると、**全 version ごと完全削除**されます。

### Memory Store (`memory_stores/<localName>/manifest.yaml`)

```yaml
name: my-store
description: 任意の説明
metadata:
  team: platform
```

- 差分対象: `name` / `description` / `metadata`
- `metadata` は patch (local に無い key は削除、それ以外は upsert)
- 削除は `archive` (one-way、unarchive 不可)。store のメモリ本体は残ります

## 🗂️ ディレクトリ構成

cmaform は **コマンド実行時の cwd** (または `CMAFORM_DIR` で指定したパス) を構成ルートとして読み書きします:

```
<cwd>/
├── agents/
│   └── *.yaml
├── skills/
│   └── <localName>/SKILL.md
├── memory_stores/
│   └── <localName>/manifest.yaml
└── cmaform.state.json
```

## 🧾 state ファイル (`cmaform.state.json`)

```json
{
  "agents": {
    "release-prep": { "id": "agent_01Qx...", "version": 6 }
  },
  "skills": {
    "slack-mention-lookup": {
      "id": "skill_013uPS...",
      "version": "1778647403232223",
      "hash": "7b8b14094e01...",
      "display_title": "slack-mention-lookup"
    }
  },
  "memory_stores": {
    "team-notes": { "id": "memstore_01...", "name": "team-notes" }
  }
}
```

- `pull` / `apply` / `sync` / `init` で更新されます
- **`.gitignore` 推奨** (Terraform state ファイルと同様に、ローカルの真実として扱う)
- 共有された state があれば、`cmaform sync` で agent 用 YAML を一括生成できます (skill 本体ファイルは前述の通り復元できません)

## 🔐 環境変数

| 変数 | 必須 | 用途 |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | ✅ | Anthropic API への認証 |
| `CMAFORM_DIR` | | 構成ルートディレクトリ (default: `cwd`) |

## ⚠️ 注意点

- Agent の `name` を変えると **新しい agent として作成**されます。リネームしたい場合は、旧 YAML を削除 → `apply` で旧 agent を archive → 新 name の YAML を追加、の順で実施してください。
- Skill ディレクトリを消して `apply` するのは **破壊的**です。skill には archive 概念がありません。
- 完全な再現性のためには Anthropic Console で手動変更を加えないでください。常に YAML / `SKILL.md` / `manifest.yaml` 経由で更新します。

## 🛠️ 開発

```bash
pnpm install
pnpm dev -- --help     # ソースから実行 (tsx)
pnpm typecheck
pnpm build             # tsup で dist/cli.js にバンドル
node dist/cli.js --help
```

## 🏗️ アーキテクチャ

- **CLI**: 単一ファイル Node.js スクリプト (~2.2k LOC)。サブコマンドは `src/cli.ts` の `main()` で dispatch
- **SDK**: `@anthropic-ai/sdk` (`beta.agents.*` / `beta.skills.*` / `beta.memoryStores.*`)
- **Skill upload**: 初回作成は SDK 経由。version 更新は API が要求する `<skillName>/<rel>` の filename prefix を保持するため、`fetch` + `FormData` で `multipart/form-data` を自前 POST
- **差分表示**: LCS ベースの行差分 + 前後 2 行のコンテキスト圧縮 + TTY 時のみ ANSI カラー化
- **ビルド**: `tsup` で `#!/usr/bin/env node` shebang 付き ESM bundle を出力

## 📋 要件

- Node.js ≥ 22
- Managed Agent / Skills / Memory Stores の beta API にアクセスできる Anthropic API key

## 📄 ライセンス

MIT
