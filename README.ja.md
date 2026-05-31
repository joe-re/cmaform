<h1 align="center">cmaform</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/cmaform"><img src="https://img.shields.io/npm/v/cmaform.svg" alt="npm version"></a>
  <a href="https://github.com/joe-re/cmaform/actions/workflows/ci.yml"><img src="https://github.com/joe-re/cmaform/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/npm/l/cmaform.svg" alt="License: MIT"></a>
</p>

<p align="center">
  <a href="./README.md">English</a> | 日本語
</p>

**cmaform** は **Claude Managed Agents とその周辺リソース** — agents / skills / memory stores / environments / vaults — を Terraform 風のワークフローで宣言的に管理する CLI です。1 リソース = 1 ファイル (YAML / SKILL.md / manifest.yaml) で git にコミットでき、`cmaform plan` で差分を確認、`cmaform apply` で適用します。

```text
  [~] update agent       "release-prep" (id=agent_01Qx..., version=6)
       file: agents/release-prep.yaml
       ~ system:
           ... (12 unchanged lines)
         - 既存ロジック...
         + 改修ロジック...
           ... (8 unchanged lines)
  [+] create skill       "spec-lookup"
       dir:  skills/spec-lookup
       hash: 7b8b14094e01...

Plan (agents):         0 to add, 1 to change, 0 to archive, 5 unchanged.
Plan (skills):         1 to add, 0 to change, 0 to delete, 0 unchanged.
Plan (memory_stores):  0 to add, 0 to change, 0 to archive, 0 unchanged.
Plan (environments):   0 to add, 0 to change, 0 to archive, 1 unchanged.
Plan (vaults):         0 to archive, 1 unchanged.
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

> Claude Managed Agents と Skills / Memory Stores / Environments / Vaults の関連 API は現時点で **beta** です。cmaform は内部で `@anthropic-ai/sdk` の `beta.agents.*` / `beta.skills.*` / `beta.memoryStores.*` / `beta.environments.*` / `beta.vaults.*` を直接呼びます。

## 🚀 使い方

### コマンド一覧

| コマンド                                                | 説明                                                                                                                                                                                                       |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cmaform pull <id> [--by-id]`                           | `agent_*` / `skill_*` / `memstore_*` / `env_*` / `vlt_*` ID から remote → local / state に取り込む。`--by-id` で agent YAML の `multiagent.agents[]` / `skills[]` を name 形式に書き換えず生 ID のまま出力 |
| `cmaform plan [--verbose\|-v] [target...]`              | local YAML / state / remote の差分を Terraform 風に表示                                                                                                                                                    |
| `cmaform apply [--yes\|-y] [--verbose\|-v] [target...]` | plan を表示 → 確認 → 適用 → state 保存                                                                                                                                                                     |
| `cmaform sync [--by-id]`                                | state にある全 entry を remote から取り直し YAML を再生成。`--by-id` で agent YAML の `multiagent.agents[]` / `skills[]` を name 形式に書き換えず生 ID のまま出力                                          |
| `cmaform init`                                          | state ファイルを remote の現状に合わせて初期化 / 同期 (remote 書き込みなし、`terraform init` 相当)                                                                                                         |
| `cmaform list`                                          | local files / state / remote を並べて表示                                                                                                                                                                  |
| `cmaform fmt`                                           | local YAML 内の `multiagent.agents[].id` / `skills[].skill_id` を `cmaform.state.json` を引いて name 形式に書き戻す                                                                                        |

### plan / apply の絞り込み

`plan` / `apply` の末尾に target を渡すと対象を絞り込めます。target には **リソース種別** と **個別リソース名** の両方を指定できます (例: skill を先に作って `skill_id` を採番してから、その ID を埋め込んだ agent YAML を apply する、といった段階デプロイに便利)。

```bash
cmaform apply skills                     # skill だけ全部 apply
cmaform apply agents                     # agent だけ全部 apply
cmaform apply slack-mention-lookup       # skill 1 件だけ
cmaform apply release-prep --yes         # agent 1 件だけ (確認スキップ)
cmaform apply skills release-prep        # 全 skill + release-prep agent
```

`<target>` は **種別の別名** (= その種類のリソース全体に一致) か、**個別リソースの名前** (= 1 つのリソースだけに一致) のどちらかとして解釈されます。下表の別名のいずれにも当たらない場合、target は個別リソース名として扱われます。

| リソース     | 種別の別名                                                  | 個別リソース名のフォーマット          | 例                                                      |
| ------------ | ----------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------- |
| Agent        | `agent` / `agents`                                          | YAML の `name:` フィールド            | `release-prep` (`agents/release-prep.yaml`)             |
| Skill        | `skill` / `skills`                                          | `skills/` 配下のディレクトリ名        | `slack-mention-lookup` (`skills/slack-mention-lookup/`) |
| Memory Store | `memory_store` / `memory_stores` / `memstore` / `memstores` | `memory_stores/` 配下のディレクトリ名 | `team-notes` (`memory_stores/team-notes/`)              |
| Environment  | `environment` / `environments` / `env` / `envs`             | `environments/` 配下のディレクトリ名  | `python-dev` (`environments/python-dev/`)               |
| Vault        | `vault` / `vaults`                                          | `vaults/` 配下のディレクトリ名        | `my-bot` (`vaults/my-bot/`)                             |

`plan` は create / update の diff を対称な形式で展開します。新規リソースは `+ field: ...` ブロック、更新は `~ field: ...` ブロックで表示されます。長い文字列フィールド (`system` / `description`) は冒頭 3 行 + `... (N lines hidden)` で折りたたまれます。`--verbose` を付けると全文表示になります。

個別名を指定して local YAML / state / remote のどこにも見つからない場合は exit code `2` でエラー終了します。種別を指定して該当 0 件の場合はエラーになりません (`0 to add, 0 to change, ...` と出るだけ)。

### 既存リソースの取り込み

```bash
cmaform pull agent_011CaSWcCrMdQdp4SA6TVdH6   # agents/<name>.yaml を生成
cmaform pull skill_013uPS15B3Kw82NpjH4uNQep   # state のみ更新 (SKILL.md は再生成しない)
cmaform pull memstore_01ABC...                # memory_stores/<name>/manifest.yaml を生成
cmaform pull env_015G...                      # environments/<name>/manifest.yaml を生成
cmaform pull vlt_011CaQ...                    # vaults/<name>/manifest.yaml を生成 (credentials は cmaform 管理対象外)
```

Skill 本体ファイル (`SKILL.md` 等) は **API が content を返さない**ため、`pull` でも復元できません。state には ID / version / display_title だけが記録され、ローカルファイルは自分で書く必要があります。

## 📦 リソース

cmaform は 5 種類のリソース — **agents** / **skills** / **memory stores** / **environments** / **vaults** — を管理します。それぞれが構成ルート直下の独立したディレクトリに置かれます。(vault は cmaform で作成後、Anthropic Console 上で設定を行ってください。)

### Agent (`agents/<name>.yaml`)

```yaml
name: my-agent # workspace 内で一意。これが識別キー
model:
  id: claude-sonnet-4-6
  speed: standard # standard | fast
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
    skill_id: xlsx # Anthropic 提供 skill は ID 形式のまま
  - type: custom
    name: slack-mention-lookup # = skills/ 配下のディレクトリ名
    version: latest # 省略可
```

raw ID 形式 (`skill_id: skill_01XXXXXX`、 `type: custom`) も受け付けます。`name` と `skill_id` はどちらでも書けます。解決ルールは下の [Name-based references (論理名参照)](#-name-based-references-論理名参照) を参照してください。

> ⚠️ Skill には archive がありません。ディレクトリを消して `apply` を実行すると、**全 version ごと完全削除**されます。

### 🔗 Name-based references (論理名参照)

`multiagent.agents[]` と `skills[]` は raw ID だけではなく、**論理名 (logical name)** での参照を受け付けます。論理名は `plan` / `apply` 時に解決されるため、workspace 固有 ID を YAML に書き込まずに参照させることができます。

```yaml
# agents/coordinator.yaml
multiagent:
  type: coordinator
  agents:
    - type: agent
      name: spec-qa # = agents/spec-qa.yaml の `name` フィールド
    - type: agent
      name: release-prep
      version: latest # 省略可
skills:
  - type: custom
    name: slack-mention-lookup # = skills/ 配下のディレクトリ名
```

論理名の解決順序:

1. `cmaform.state.json` — 既に local で track されていればその ID を使う
2. Remote — `findAgentByName` / `findSkillByDisplayTitle` (run 内でキャッシュ)
3. 同 run の apply セット — 当該 name の YAML が local にあり、今回作成される予定であれば **forward dependency** として扱う。plan 中は placeholder で表示し、依存先が作成された直後に実 ID で置換する
4. いずれにも当たらない場合は `plan` / `apply` を中断し、未解決の name を明示

#### `pull` / `sync` での書き戻し

remote から YAML を書き出す際、`id` / `skill_id` のうち state で track されているものは自動的に `name:` 形式に置換されます。state に無い ID はそのまま `id` 形式で残します。

書き戻し時の自動置換を無効化したい場合は `pull` / `sync` に `--by-id` を渡してください。生 ID 形式のまま YAML に出力されます。

#### raw ID 形式

`{ type: agent, id: agent_... }` / `{ type: custom, skill_id: skill_... }` 形式も受け付けます。name 形式と挙動は同じです。

エントリに **`name:` と `id:` (または `skill_id:`) を両方書いた**場合、cmaform は name 解決の結果とピン留めされた ID が一致するか検査し、不一致なら `plan` / `apply` を中断します。id 形式から name 形式への移行期に safety net として使えます。整合が取れたら `cmaform fmt` で raw ID を落とせます。

`type: anthropic` の skill (`xlsx` のような well-known ID) は `skill_id` 形式を使います。`type: self` の agent 参照はどちらも使いません。

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

### Environment (`environments/<localName>/manifest.yaml`)

```yaml
name: python-dev
description: 任意の説明
config:
  type: cloud
  packages:
    pip:
      - pandas
      - numpy==2.2.0
    npm:
      - express
  networking:
    type: limited
    allowed_hosts:
      - https://api.example.com
    allow_mcp_servers: true
    allow_package_managers: true
metadata: {}
```

- 差分対象: `name` / `description` / `metadata` / `config`
- 現状は `config.type: cloud` のみ対応 (self-hosted は対象外)
- 空配列の packages / limited networking の false デフォルト / サーバ側の `type: 'packages'` マーカは normalize で吸収されるため plan は idempotent
- 削除は `archive`。既存セッションは継続使用できるが、新規セッション作成はできなくなる

### Vault (`vaults/<localName>/`)

> **対応状況:** ⚠️ _部分対応 — vault の設計は cmaform 側でまだ検討中です。_
>
> | 操作              | cmaform 対応 | 備考                                                                                                                                                                                                     |
> | ----------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | Vault の作成      | ✅           | 新規 local manifest があれば作成される                                                                                                                                                                   |
> | Vault の archive  | ✅           | local manifest を削除すると archive。API 側で credentials も cascade archive                                                                                                                             |
> | Vault の更新      | ❌           | 初回作成後の `display_name` / `metadata` 変更は **plan に出ません**。リネームしたい場合は archive → 作り直し                                                                                             |
> | Credential の管理 | ❌           | credential は cmaform 管理対象外です (secret 解決の設計待ち)。 attach / rotate は [Anthropic Vault Credentials API](https://platform.claude.com/docs/en/managed-agents/credentials) を直接使ってください |
>
> 将来リリースで vault update と secret backend 込みの credential 管理を順次サポート予定です。

vault は MCP server 用 credential を保持する入れ物です。現リリースのローカル構成は意図的に最小限です:

```
vaults/
└── my-bot/
    └── manifest.yaml
```

**`manifest.yaml`** — vault 定義:

```yaml
display_name: my-bot
metadata:
  external_user_id: bot
```

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
├── environments/
│   └── <localName>/manifest.yaml
├── vaults/
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
  },
  "environments": {
    "python-dev": { "id": "env_01...", "name": "python-dev" }
  },
  "vaults": {
    "my-bot": { "id": "vlt_01...", "display_name": "my-bot" }
  }
}
```

- `pull` / `apply` / `sync` / `init` で更新されます
- **`.gitignore` 推奨** (Terraform state ファイルと同様に、ローカルの真実として扱う)
- 共有された state があれば、`cmaform sync` で agent 用 YAML を一括生成できます (skill 本体ファイルは前述の通り復元できません)

## 🔐 環境変数

| 変数                | 必須 | 用途                                    |
| ------------------- | ---- | --------------------------------------- |
| `ANTHROPIC_API_KEY` | ✅   | Anthropic API への認証                  |
| `CMAFORM_DIR`       |      | 構成ルートディレクトリ (default: `cwd`) |

## ⚠️ 注意点

- Agent の `name` を変えると **新しい agent として作成**されます。リネームしたい場合は、旧 YAML を削除 → `apply` で旧 agent を archive → 新 name の YAML を追加、の順で実施してください。
- Skill ディレクトリを消して `apply` するのは **破壊的**です。skill には archive がありません。
- 完全な再現性のためには Anthropic Console で手動変更を加えないでください。常に YAML / `SKILL.md` / `manifest.yaml` 経由で更新します。

## 🛠️ 開発

```bash
mise install
pnpm install
pnpm dev -- --help     # ソースから実行 (tsx)
pnpm typecheck
pnpm build             # tsup で dist/cli.js にバンドル
node dist/cli.js --help
```

## 📋 要件

- Node.js ≥ 22
- Claude Managed Agents と Skills / Memory Stores / Environments / Vaults の関連 beta API にアクセスできる Anthropic API key

## 📄 ライセンス

MIT
