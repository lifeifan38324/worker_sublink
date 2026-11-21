# worker-sublink

把多个机场订阅聚合成一份可直接使用的 **mihomo（Clash.Meta）** 或 **sing-box** 配置，并部署在 Cloudflare Workers 上。

整个流程是「拉订阅 → 解析节点 → 按配置建分组 → 按 ruleset 拼规则 → 套模板/生成骨架」：

```
GET /api/convert
      │
      ├─ subs     ── 多个机场订阅 ──┐
      │                            ├─ 解析 ss/vmess/trojan/vless/hysteria2
      ├─ config   ── 分流配置 ─────┤  建 proxy-groups、拉取规则列表
      │                            │
      └─ template ── 基础模板 ─────┴─ mihomo: 往 YAML 模板里写三段
                                      sing-box: 重新生成 JSON 骨架
```

- 运行时：Cloudflare Workers（`workerd`），静态页由 Workers Static Assets 托管
- 语言：TypeScript，无框架、无构建步骤，`wrangler` 直接打包 `src/index.ts`
- 唯一运行时依赖：`yaml`（用于保留模板注释地改写 YAML）

---

## 功能

- **多订阅聚合**：一次请求拉取多个订阅，节点名自动加 `名称_` 前缀；跨订阅仍重名的节点自动加序号后缀（`名字 2`、`名字 3`），不会互相覆盖。
- **三种订阅内容都能吃**：Clash/mihomo YAML、Base64 包裹的 YAML、Base64 包裹的分享链接、明文分享链接。
- **两种输出目标**：
  - `mihomo`：以你自己的 YAML 模板为骨架，只替换 `proxies` / `proxy-groups` / `rules`，**保留模板里的注释、DNS、TUN 等所有字段**。
  - `sing-box`：重新生成一份完整 JSON（log / inbounds / outbounds / route），GEOIP、GEOSITE 自动转成远程 `rule_set`（`.srs`），适配 sing-box 1.11+。
- **分流配置驱动**：分组类型、正则筛选、组间引用、规则列表 URL、内联规则、`final` 兜底，全部写在 JSON 里。
- **单页操作界面**：填表 → 生成订阅链接 → 复制/下载配置，带统计信息和黄色的「转换提示」。
- **容错而不是整体失败**：某个订阅拉取失败、某条规则内核不支持、某个分组没匹配到节点，都会降级并给出警告，其余内容照常输出。
- **配置零硬编码**：订阅、分流配置、模板三项默认值全部来自环境变量；缺失时返回 500 并明确指出缺哪个变量，不会偷偷用一个内置默认值。

---

## 快速开始

### 1. 环境要求

- Node.js 18+（建议 20 或 22）
- npm（项目使用 `package-lock.json`，不要混用 pnpm/yarn）
- 一个 Cloudflare 账号（仅部署时需要）

### 2. 安装与配置

```bash
npm install
cp .dev.vars.example .dev.vars   # Windows: copy .dev.vars.example .dev.vars
```

编辑 `.dev.vars`，至少填好订阅、分流配置、模板三项（字段说明见下一节）：

```ini
ALLOW_LOCAL_FETCH=true
SUBSCRIBE_MAP=[{name=机场A,url=https://example.com/api/v1/client/subscribe?token=xxx}]
CONVERT_CONFIG=https://example.com/config.json
TEMPLATE_URL=https://example.com/template.yaml
```

### 3. 启动

```bash
npm run dev
```

打开 <http://localhost:8787>，页面顶部会显示「哪些环境变量已配置」。

### 4. 常用脚本

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 本地开发服务器（默认 8787，读 `.dev.vars`） |
| `npm run dev:remote` | 在 Cloudflare 边缘环境调试（会用到线上 secret） |
| `npm run check` | `tsc --noEmit` 类型检查 |
| `npm run types` | `wrangler types` 重新生成 `worker-configuration.d.ts` |
| `npm run tail` | 实时查看线上日志 |
| `npm run deploy` | 部署到 Cloudflare Workers |

> 改了 `wrangler.jsonc` 的 `vars` 后要重新跑 `npm run types`，否则 `Env` 类型里没有新变量。

---

## 环境变量

| 变量 | 必填 | 线上存储 | 说明 |
| --- | --- | --- | --- |
| `SUBSCRIBE_MAP` | 是 | secret | 订阅列表。支持 `[{name=机场A,url=https://...}]` 自定义写法，或 JSON 数组 `[{"name":"机场A","url":"https://...","ua":"clash.meta"}]`。也可以用页面上的「每行一条：名称 链接」覆盖。 |
| `CONVERT_CONFIG` | 是 | secret | 分流配置。可以是 **URL**，也可以直接是 **JSON 文本**（含 `proxy_group` 与 `ruleset`）。 |
| `TEMPLATE_URL` | 生成 mihomo 时必填 | secret | 基础模板 YAML 的地址。生成 sing-box 时完全不使用它，也不会去请求。 |
| `ALLOW_LOCAL_FETCH` | 否 | var | 是否允许拉取 `127.0.0.1`、`localhost`、`*.local` 等内网地址。只接受 `true` / `false`，默认 `false`；写成别的值会直接报 500。**线上必须保持 `false`**（防 SSRF）。 |

> 前三项含订阅 token，线上只能以 secret 形式存在；`wrangler.jsonc` 的 `vars` 里只能放 `ALLOW_LOCAL_FETCH`，否则会因同名冲突部署失败。

### 取值优先级

```
请求参数（subs / config / template）  >  环境变量
```

页面上留空的字段不会出现在生成的链接里，服务端自动回落到环境变量——所以订阅 token 可以只存在 Worker 里，分享出去的链接只带 `target`。

### 三种设置方式

```bash
# 本地开发：写 .dev.vars（已被 .gitignore 忽略）
# 线上持久化：写 secret，加密存储
npx wrangler secret put SUBSCRIBE_MAP

# 临时覆盖单次命令（不落盘）
npx wrangler dev --var SUBSCRIBE_MAP='[{name=测试,url=https://...}]'
npx wrangler deploy --var TEMPLATE_URL='https://...'
```

注意三点：

1. **`export SUBSCRIBE_MAP=...` 对 wrangler 无效**。wrangler 不会读取当前 shell 的环境变量，只认 `.dev.vars`、`--var`、`--env-file`、`wrangler.jsonc` 的 `vars`。
2. **secret 与 var 不能同名**。Cloudflare 的 secret 和普通变量共用命名空间，所以 `SUBSCRIBE_MAP` / `CONVERT_CONFIG` / `TEMPLATE_URL` 只以 secret 形式存在，`wrangler.jsonc` 的 `vars` 里只留 `ALLOW_LOCAL_FETCH`。违反这一点会报 `Binding name 'XXX' already in use [code: 10053]`。
3. 因为 `wrangler types` 只根据 `vars` 和本地 `.dev.vars` 生成类型，刚克隆的仓库没有 `.dev.vars`，这三个变量就会缺类型，所以在 `src/env.d.ts` 里固定声明；新增 secret 时记得同步补。

---

## 使用方法

### 网页操作

1. **订阅链接**：每行一条 `名称 链接`，名称可省略（自动叫「订阅1」「订阅2」）。
2. **客户端**：选 `mihomo` 或 `sing-box`。
3. **分流配置**：填配置链接，或直接把 JSON 粘进来。
4. **基础规则配置**：填模板 YAML 的链接（仅 mihomo 需要）。
5. 点「生成订阅链接」，得到形如：

```
https://your-worker.workers.dev/api/convert?target=mihomo&subs=...&config=...&template=...
```

这个地址可以直接填进 Clash Verge / mihomo / sing-box 客户端作为订阅。结果区还会显示节点数、分组数、规则数、耗时、体积、每个订阅的解析格式，以及可复制的完整配置（预览区只显示前 120 行，「复制」按钮复制的是全文）。

### 直接调接口

```bash
# 生成配置（参数需 URL 编码，多行订阅用 %0A 连接）
curl 'https://your-worker.workers.dev/api/convert?target=mihomo' \
  --get \
  --data-urlencode 'subs=机场A https://example.com/sub?a=1
机场B https://example.com/sub?b=2' \
  --data-urlencode 'config=https://example.com/config.json' \
  --data-urlencode 'template=https://example.com/template.yaml' \
  -o config.yaml

# 只看统计，不返回配置正文
curl '...&stats=1'
```

---

## API

### `GET /api/health`

```json
{ "status": "ok", "runtime": "workerd" }
```

### `GET /api/convert`

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `subs` | 是* | 订阅列表纯文本，每行 `名称 链接`。*不传则用 `SUBSCRIBE_MAP`。 |
| `config` | 是* | 分流配置 URL 或 JSON 文本。*不传则用 `CONVERT_CONFIG`。 |
| `template` | mihomo 必填* | 模板 YAML 地址。*不传则用 `TEMPLATE_URL`。 |
| `target` | 否 | `mihomo` / `clash` / `meta` / `stash` → mihomo；`singbox` / `sing-box` / `sbox` → sing-box。不传时按 `User-Agent` 猜（含 `sing-box` 则 sing-box，否则 mihomo）。 |
| `stats` | 否 | 传 `1` 时只返回统计 JSON，不返回配置正文。 |

**成功响应**

- `Content-Type`：mihomo → `text/yaml; charset=utf-8`；sing-box → `application/json; charset=utf-8`
- `x-convert-stats`：URL 编码的 JSON，含节点数、分组数、规则数、各订阅明细、耗时、字节数
- `x-convert-warnings`：URL 编码的 JSON **数组**，前端用 `decodeURIComponent` + `JSON.parse` 还原
- `profile-update-interval: 24`、`cache-control: no-store`

**错误响应**：统一 `{ "error": "..." }`

| 状态码 | 典型原因 |
| --- | --- |
| 400 | 订阅行里没有 http(s) 链接、分流配置不是合法 JSON、缺少 `proxy_group`/`ruleset`、链接协议不对、访问内网地址被拒 |
| 413 | 拉取内容超过 8 MB |
| 500 | 三个必填配置缺失、`ALLOW_LOCAL_FETCH` 值非法、环境变量格式错误 |
| 502 | 模板不是合法 YAML、所有订阅都没解析出节点 |

> 校验顺序是「订阅 → 分流配置 → 模板」，所以同时缺多个时，报的是最靠前的那个。sing-box 目标不会校验模板。

---

## 订阅输入格式

### 页面上 / `subs` 参数

```text
机场A https://example.com/api/v1/client/subscribe?token=xxx
https://example.com/another-sub
# 以 # 或 // 开头的行会被忽略
```

- 一行一个订阅；第一个 `http(s)://` 之前的全部内容作为名称（名称里可以有空格）。
- 名称省略时按顺序命名 `订阅1`、`订阅2`。
- 该行找不到链接会直接报 400，并指出行号。

### 环境变量 `SUBSCRIBE_MAP`

两种写法等价，第二种可以额外指定 `ua`：

```text
[{name=机场A,url=https://example.com/sub?token=xxx},{name=机场B,url=https://...}]
```

```json
[
  { "name": "机场A", "url": "https://example.com/sub?token=xxx", "ua": "clash.meta" }
]
```

### 订阅响应支持的内容

| 内容 | 识别方式 |
| --- | --- |
| Clash/mihomo YAML | 直接解析 `proxies` 数组 |
| Base64(YAML) | Base64 解码后再按 YAML 解析 |
| Base64(分享链接) | Base64 解码后逐行解析 |
| 明文分享链接 | 逐行解析 `ss://`、`vmess://`、`trojan://`、`vless://`、`hysteria2://` / `hy2://` |

补充行为：

- 默认用 `User-Agent: clash.meta` 拉订阅，可用 `ua` 字段覆盖。
- 节点名统一加 `名称_` 前缀；跨订阅重名时依次改成 `名字 2`、`名字 3`。
- 以下节点会被过滤，并计入警告：`server` 为空 / `0.0.0.0` / `127.0.0.1` / `::` / `::1`、端口非法（非数字或不在 1–65535），以及名字里带「剩余流量」「套餐到期」「官网」「订阅地址」等关键词的伪节点。
- 单个订阅失败不会中断整个请求，只是在警告里记一条「拉取失败」。

---

## 分流配置格式

顶层必须同时有 `proxy_group` 和 `ruleset` 两个数组（也接受别名 `proxyGroups` / `proxy-groups`、`rulesets` / `rules`）。

```json
{
  "proxy_group": [
    {
      "name": "手动选择",
      "type": "select",
      "other-groups": ["香港测速", "台湾测速"],
      "regex-filter": "(香港|HK|台湾|TW)"
    },
    {
      "name": "香港测速",
      "type": "ur-test",
      "other-groups": [],
      "regex-filter": "(香港|HK)",
      "test-utl": "http://www.gstatic.com/generate_204",
      "interval": 600,
      "tolerance": 300
    }
  ],
  "ruleset": [
    {
      "use-proxy": "香港测速",
      "rule-url": "https://raw.githubusercontent.com/.../ProxyHK.list"
    },
    {
      "use-proxy": "手动选择",
      "GEOIP": "CN",
      "no-resolve": true
    },
    {
      "use-proxy": "DIRECT",
      "final": true
    }
  ]
}
```

### `proxy_group[]`

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `name` | 是 | 分组名，同时作为规则里的策略名。 |
| `type` | 否 | `select`（默认）、`url-test`、`fallback`、`load-balance`。也兼容 `ur-test`、`url-test`、`urltest`、`auto`、`balance` 等写法。 |
| `other-groups` | 否 | 引用其它分组或内置策略。仅写节点名时请用 `regex-filter`。 |
| `regex-filter` | 否 | 按节点名筛选成员，忽略大小写。mihomo 风格的 `(?i)` 会被自动剥离（等价于统一加 `i`），`(?i:xxx)` 会展开成 `(?:xxx)`。 |
| `test-utl` / `test-url` | 否 | 测速地址，默认 `http://www.gstatic.com/generate_204`。**注意历史拼写 `test-utl` 是官方支持的**。 |
| `interval` | 否 | 测速间隔（秒），默认 300。 |
| `tolerance` | 否 | 切换容差（毫秒）。 |

分组构建规则：

- 可以直接引用 `DIRECT`、`REJECT`、`REJECT-DROP`、`PASS`，这些是内核内置策略，不需要定义。
- `select` 组会自动补一个 `DIRECT` 作为手动兜底。
- 引用了不存在的分组 → 忽略并警告。
- 最终没有任何成员 → 回退成 `DIRECT` 并警告。

### `ruleset[]`

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `use-proxy` | 是 | 命中后走哪个策略/分组。 |
| `rule-url` | 否 | 规则列表地址（Clash `.list` / 文本，一行一条）。 |
| `no-resolve` | 否 | 给本段所有内联规则加 `no-resolve`。 |
| `final` | 否 | `true` 表示这一段就是兜底策略，等价于最后一条 `MATCH`。 |
| 其它键 | 否 | 键名即规则类型，值可以是字符串或数组。如 `{"GEOIP":"CN"}`、`{"DOMAIN-SUFFIX":["a.com","b.com"]}`、`{"MATCH":true}`。 |

支持的规则类型：

```
DOMAIN  DOMAIN-SUFFIX  DOMAIN-KEYWORD  DOMAIN-REGEX  GEOSITE
IP-CIDR  IP-CIDR6  IP-SUFFIX  IP-ASN  GEOIP  SRC-GEOIP
SRC-IP-CIDR  SRC-PORT  DST-PORT
PROCESS-NAME  PROCESS-PATH  PROCESS-NAME-REGEX
RULE-SET  NETWORK  MATCH
```

`URL-REGEX` 是 Surge / Quantumult X 的语法，mihomo 和 sing-box 都不认，写进配置会导致整份加载失败。本项目在**三个环节**都做了跳过：

1. 解析内联规则时跳过（只记警告，不报错）；
2. 解析规则列表文件时跳过并统计行数；
3. 输出前再兜底过滤一次。

### 规则拉取与去重

- 规则列表并发 6 个拉取，失败重试一次，单次超时 20 秒；模板和规则列表都缓存 10 分钟（进程内，最多 40 条）。
- 同一条规则（`类型|值|策略` 相同）只保留一次。
- 规则列表里的 `MATCH` 和 `{"final": true}` 都会被记成兜底策略，最终输出恰好一条 `MATCH,<策略>`；没有配置兜底则用 `DIRECT`。
- 规则集指向不存在的分组时，整段跳过并警告。

---

## 两种输出的差异

| | mihomo | sing-box |
| --- | --- | --- |
| 骨架来源 | 你的 `TEMPLATE_URL` 模板 | 代码生成 |
| 模板是否必需 | **是** | 否（不会请求） |
| 保留注释 | 是（`yaml` 的 `parseDocument`） | — |
| 写入内容 | `proxies`、`proxy-groups`、`rules`，缺 `mode` 时补 `rule` | `log`、`inbounds`、`outbounds`、`route` |
| 入站 | 由模板决定 | `mixed`，`127.0.0.1:7890` |
| 节点 | 原样写入 | 转换 `ss` / `vmess` / `trojan` / `vless` / `hysteria2`，其它类型跳过并警告 |
| 分组 | `select` / `url-test` / `fallback` / `load-balance` | `selector` / `urltest`（`load-balance` 降级为 `selector`） |
| GEOIP / GEOSITE | 原样输出 | 转成远程 `rule_set`（`format: binary`，`.srs`），同时写入 `route.rule_set` |
| 兜底 | 最后一条 `MATCH,<策略>` | `route.final` |
| 无对应语法的规则 | 一般都有 | 跳过并警告，例如 `IP-ASN`、`IP-SUFFIX`、`SRC-GEOIP`、`RULE-SET`、`PROCESS-NAME-REGEX` |

> sing-box 的 `rule_set` 前缀写死在 `src/targets/singbox.ts` 的 `RULE_SET_BASE`，默认指向 `SagerNet/sing-geoip`、`SagerNet/sing-geosite`。

---

## 项目结构

```text
worker_sublink/
├── src/
│   ├── index.ts              # Worker 入口：路由、参数/环境变量解析、响应头打包、首页占位符注入
│   ├── convert.ts            # 转换编排：解析分流配置、建组、拉规则、选择输出目标、汇总警告与统计
│   ├── subscription.ts       # 订阅列表解析、订阅内容识别（YAML/Base64/分享链接）、节点去重/过滤/加前缀
│   ├── links.ts              # ss / vmess / trojan / vless / hysteria2 分享链接 → ClashProxy
│   ├── rules.ts              # 规则类型白名单、规则列表解析、URL-REGEX 跳过、规则列表拉取与缓存
│   ├── text-fetch.ts         # 统一 HTTP 拉取：UA、8MB 上限、超时、编码探测、内网地址拦截、HttpError
│   ├── cache.ts              # 进程内 TTL 缓存（模板 / 规则列表共用，最多 40 条）
│   ├── env.d.ts              # 三个 secret 变量的类型声明（wrangler types 不会生成）
│   └── targets/
│       ├── clash.ts          # 往 YAML 模板写 proxies / proxy-groups / rules
│       └── singbox.ts        # 生成 sing-box 1.11+ 配置，GEOIP/GEOSITE → rule_set
├── public/
│   ├── index.html            # 单页表单（无框架，原生 JS）
│   └── _samples/             # 本地测试数据（订阅样例、分流配置、模板）
├── wrangler.jsonc            # Worker 配置：入口、静态资源、非敏感 vars（ALLOW_LOCAL_FETCH）
├── .dev.vars.example         # 环境变量模板（复制成 .dev.vars）
├── worker-configuration.d.ts # wrangler types 生成的 Env 类型，不要手改
├── tsconfig.json
└── package.json
```

### 请求在代码里的走向

1. `src/index.ts` → 取参数/环境变量，缺必填项直接 500；`target` 先看参数再看 UA。
2. `src/convert.ts#runConvert` → 解析订阅列表、加载分流配置（URL 或内联 JSON）。
3. `src/subscription.ts` → 并发拉订阅、识别格式、解析节点、加前缀、去重、过滤伪节点。
4. `convert.ts#buildGroups` → 建组，处理组间引用和正则。
5. `convert.ts#buildRulePlan` → 拉规则列表（限流 + 重试），合并内联规则，去重，定兜底。
6. `src/targets/*` → 输出 YAML 或 JSON。
7. `src/index.ts` → 把统计和警告塞进响应头，正文直接返回。

---

## 本地测试数据

`public/_samples/` 下的文件可以通过本地 dev server 直接访问（`ALLOW_LOCAL_FETCH=true` 时允许拉本机地址）：

| 文件 | 用途 |
| --- | --- |
| `sub-a.yaml` | Clash YAML 格式订阅 |
| `sub-b.links.txt` | 明文分享链接（ss/vmess/trojan/vless/hysteria2） |
| `sub-b.txt` | Base64 包裹的分享链接 |
| `sub-empty.txt` | 空订阅，用于测试「没解析出节点」 |
| `convert-config.json` | 分流配置示例（分组 + 规则列表 + 内联 GEOIP） |
| `tpl-mini.yaml` | 最小 mihomo 模板（含注释，可验证注释是否保留） |
| `rules-a/b/c.list` | 规则列表，`rules-c.list` 里含 `URL-REGEX`，用于验证跳过逻辑 |

启动 `npm run dev` 后可以这样试：

```bash
# mihomo（注意把换行编码成 %0A）
curl 'http://localhost:8787/api/convert?target=mihomo&stats=1' \
  --get \
  --data-urlencode 'subs=样例A http://localhost:8787/_samples/sub-a.yaml
样例B http://localhost:8787/_samples/sub-b.txt' \
  --data-urlencode 'config=http://localhost:8787/_samples/convert-config.json' \
  --data-urlencode 'template=http://localhost:8787/_samples/tpl-mini.yaml'

# sing-box（不需要 template）
curl 'http://localhost:8787/api/convert?target=singbox&stats=1' \
  --get \
  --data-urlencode 'subs=样例B http://localhost:8787/_samples/sub-b.links.txt' \
  --data-urlencode 'config=http://localhost:8787/_samples/convert-config.json'
```

把 `stats=1` 去掉就能拿到完整配置正文；加上 `-D -` 可以查看 `x-convert-stats` / `x-convert-warnings` 响应头。

---

## 部署到 Cloudflare

```bash
npx wrangler login
npm run check     # 先过类型检查
npm run deploy    # 首次部署，创建 Worker 并上传 public/

# 部署成功后再写三项配置（加密存储；不要同时写进 vars，否则同名冲突）
npx wrangler secret put SUBSCRIBE_MAP
npx wrangler secret put CONVERT_CONFIG
npx wrangler secret put TEMPLATE_URL
```

部署完成后访问 `https://worker-sublink.<你的子域>.workers.dev`。自定义域名可在 Cloudflare 控制台的 Worker → Settings → Domains & Routes 里绑定。

> 无浏览器环境（远程 SSH、容器）用 `npx wrangler login --device`，终端会给出验证链接和设备码，在任意浏览器里授权即可。

部署后自检：

```bash
BASE=https://worker-sublink.<你的子域>.workers.dev
curl "$BASE/api/health"                                  # {"status":"ok","runtime":"workerd"}
curl "$BASE/api/convert?target=mihomo&stats=1"           # 节点/分组/规则统计
curl -sD - -o /dev/null "$BASE/api/convert?target=singbox" | grep -i x-convert
```

要点：

- `assets.run_worker_first = true` 是必须的：首页要先经过 Worker 注入环境变量提示，不能直接命中静态资源。
- 生产环境的 `ALLOW_LOCAL_FETCH` 保持 `false`；`wrangler.jsonc` 里已经默认 `false`。
- 先部署再设 secret，否则 Worker 还不存在；secret 改完立即生效，不需要重新部署。
- 三项配置**只能**以 secret 形式存在。若哪天把它们加回 `wrangler.jsonc` 的 `vars`，会报 `Binding name already in use`。
- secret 写入后无法读回明文，只列出名称（`npx wrangler secret list`），需要修改就重新 `put` 覆盖。
- 订阅链接里的 token 等同于密码，**不要**写进 `wrangler.jsonc`、README、issue 或截图。要提交代码时只保留 `.dev.vars.example` 这种占位符。

---

## 安全说明

- **SSRF 防护**：默认拒绝 `localhost`、`127.*`、`0.0.0.0`、`::1`、`169.254.*`、`*.local`、`*.internal`，只允许 `http/https`。`ALLOW_LOCAL_FETCH` 仅为本地调试而存在。
- **大小与时间限制**：单次拉取上限 8 MB（先看 `Content-Length`，再流式累计，超限立即中断），默认超时 15 秒，规则列表 20 秒。
- **错误信息不泄露 token**：首页注入的环境变量默认值提示里，`token` / `key` / `password` / `secret` / `auth` 查询参数会被替换成 `***`，并且超长内容会被截断。
- **分享链接本身含明文**：`/api/convert?subs=...` 里的订阅地址是 GET 参数，会出现在浏览器历史、代理日志和 Referer 中。更稳妥的做法是把订阅只放在 Worker 的 secret 里，分享时只带 `target`。
- **`.gitignore` 已覆盖**：`.dev.vars*`、`.env*`、`*.pem` / `*.key` / `*.p12` / `*.pfx`、`secrets.json`、`node_modules/`、`.wrangler/`、`.workbuddy/`。注意 `!.dev.vars.example` 是白名单，示例文件要提交。

### 文档与仓库中的敏感信息

本 README 刻意**不包含**任何真实运行数据，只使用占位符：

| 不写入文档 | 文档中的写法 |
| --- | --- |
| 真实订阅地址、token、密码 | `https://example.com/sub?token=xxx` |
| 线上 Worker 子域、Account ID | `https://worker-sublink.<你的子域>.workers.dev` |
| 机场名称、节点名、分组名 | `机场A`、`机场B` |
| 本地绝对路径、用户名 | 只写相对路径 `src/...` |

提交前可以这样自查（命中即说明有真实值混入）：

```bash
git grep -nEi 'token=[A-Za-z0-9]{8,}|workers\.dev|accountid|/Users/|/home/|C:\\Users|C:/Users' -- . ':!README.md'
git check-ignore -v .dev.vars    # 有输出即说明被忽略规则命中，未被跟踪
```

---

## 常见问题

**首页显示「环境变量未配置」**
`.dev.vars` 没生效：确认文件名就是 `.dev.vars`（不是 `.dev.vars.txt`），并且在项目根目录；改完要重启 `npm run dev`。线上则确认执行过 `wrangler secret put`。

**在 shell 里 `export` 了变量，但 Worker 读不到**
wrangler 不读 shell 环境变量。用 `.dev.vars`、`--var`、`--env-file`，或线上 `secret put`。

**生成 mihomo 报「缺少基础模板」**
`TEMPLATE_URL` 和 `template` 参数都为空。填一个，或者改用 `target=singbox`（不需要模板）。

**分组是空的 / 只有 DIRECT**
`regex-filter` 没匹配到任何节点，或者 `other-groups` 引用了不存在的分组。看黄色提示框里的具体警告，也可以先用 `stats=1` 确认订阅解析出了多少节点。

**提示「跳过 N 条内核不支持的规则」**
规则列表里含 `URL-REGEX`（或其它非白名单类型）。这是预期行为：跳过比让整份配置加载失败更好。需要这些规则就换一份规则列表。

**规则列表拉取失败**
源站限速或超时。已内置并发 6、失败重试一次、10 分钟缓存；仍失败时该段规则会缺失，提示框里会列出具体 URL。

**sing-box 里 GEOIP 报 `unevaluatedProperties`**
本项目已经改用远程 `rule_set`（`.srs`），不再输出 `geoip` 字段。如果你手动改过输出，注意 sing-box 1.11 起规则里不允许直接写 `geoip` / `geosite`。

**改了 `wrangler.jsonc` 的 `vars`，类型报错**
跑 `npm run types` 重新生成 `worker-configuration.d.ts`。如果新增的是 secret（不在 `vars` 里），要到 `src/env.d.ts` 手工补类型。

**`wrangler secret put` 报 `Binding name 'XXX' already in use [code: 10053]`**
该变量还在 `wrangler.jsonc` 的 `vars` 里。Cloudflare 的 secret 和普通变量共用命名空间，先从 `vars` 删除、重新 `deploy`，再执行 `secret put`。

**生成的订阅在客户端里不更新**
响应带 `cache-control: no-store` 和 `profile-update-interval: 24`；客户端侧的刷新间隔由客户端自己控制，可在客户端里手动更新订阅。
