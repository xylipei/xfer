---
name: xfer-transfer
description: |
  Move files between this machine and other devices — laptop, phone, tablet —
  agent-first. Use when the user wants to send a file to another computer or a
  phone on the same Wi-Fi, get files *from* a phone onto this machine, receive a
  file someone is serving, or hand a large file over without uploading it to a
  cloud. Zero-dependency CLI; phone/tablet need no install (browser page with a
  6-character code or QR); downloads are sha256-verified and resumable.
triggers:
  - "发到另一台电脑"
  - "传到手机"
  - "发到平板"
  - "从手机传过来"
  - "局域网传文件"
  - "send this file to"
  - "receive a file"
  - "transfer file between machines"
---

# xfer — agent-first file transfer, phone/tablet/laptop

`xfer` is at `/Users/lipei/Desktop/xs/public/xfer/xfer.mjs`, symlinked on PATH as
`xfer`. One JSON object per line on stdout; QR goes to stderr; non-zero exit on
failure. `xfer -h` lists flags.

## 先按设备选用法

| 用户说 | 用什么 |
|---|---|
| 另一台电脑 / 服务器 | `xfer send <file>`（默认回环）+ 对方 `xfer recv`，或 SSH 隧道 |
| 手机 / 平板要下载 | `xfer send <file> --lan --web --qr` → 把 `phoneUrl` 给用户 |
| 手机要发文件给这台 Mac | 再加 `--upload <dir>`，让用户在页面上选择/拖放 |
| 不想让人装任何东西 | `--web`：手机浏览器直接打开即可 |

## 安全铁律

1. **默认不要加 `--lan`。** 不加只绑 `127.0.0.1`。用户明确要“发到手机/平板/另一台设备”才加。
2. **敏感文件默认发不出去**（`.env`、`~/.ssh/*`、`*.pem`、`id_rsa`）。不要自行加 `--allow-sensitive`。
3. **`--upload` 会开一个写入面。** 只指到专用目录（如 `./inbox`），**不要**指到 `~/`、项目根或 `.git`；事后告诉用户文件落在哪。
4. **token / 短码就是凭据。** 把 `phoneUrl`（`?k=`）交给用户，说明一次性、默认 10 分钟过期；不要写进文件或反复复述。
5. **跨网络不要 `--lan`。** 用 `ssh -L 8792:127.0.0.1:8792 user@host` 或 `cloudflared tunnel`，隧道内仍绑回环。
6. **只接收用户给的链接**；`--insecure` 仅在用户接受证书风险时用。
7. **发送端后台运行并在 `{"event":"done"}` 后停掉**，不要留静默 listener。

## 发到手机 / 平板

```bash
xfer send ./photos --lan --web --qr --upload ./inbox --ttl 900
```

`ready` 里给用户的字段：

```json
{"event":"ready","code":"6yx8fp","phoneUrl":"http://10.0.9.2:8792/?k=6yx8fp",
 "mdnsUrl":"http://your-mac.local:8792/?k=6yx8fp","upload":"/abs/inbox","expiresInSec":900}
```

回复里写清三件事：**phoneUrl**、**有效期**、**手机不用装任何东西**；
如果 `--upload` 开着，再补一句“页面上可以直接选择文件传回这台电脑，落在 `<dir>`”。

iOS 提醒：首次访问会弹「允许本地网络」；锁屏会挂起大文件下载（Range 可续传）；
文件存进「文件」App。Android 用 Chrome 直接下到「下载」。

## 反向：手机 → 本机

页面上的「选择文件 / 拖放」走 `PUT /u/<name>`：

- 同名**不覆盖**，自动 `name-1.ext`；
- 超过 `--max-upload`（默认 2048 MB）返回 413 并删掉临时文件；
- 服务端每收一个文件打印 `{"event":"upload","file":…,"bytes":…,"sha256":…}`。
  需要跟用户确认时，用 `shasum -a 256 <dir>/<file>` 对一下 `sha256`。

## 电脑 / CLI

```bash
xfer send ./report.pdf                       # 回环 + 一次性
xfer recv "http://10.0.9.2:8792/?k=6yx8fp" --out ./inbox
xfer info "<url>"                            # 先看清单再决定
```

`recv` 会自动改用 `/index.json`，所以 `?k=` 的网页链接也能直接喂给它。

## 版本与升级

- 先跑 `xfer doctor`：拿 `version` / `proto` / `installPath` / `onPathMatches`。
- **两端 `proto` 必须相同**。不一致就升级，不要硬传；接收端会直接拒绝并报
  `protocol mismatch`。
- 升级顺序：**先发送端，再接收端**。升级前确认没有传输在进行。
- 安装/升级一律固定版本 + 校验和，不要 `curl | sh`：
  `install.sh --version X.Y.Z --sha256 <hex>`；
  回滚是 `install.sh --rollback`，不需要重新下载。
- 升级后用 `xfer -V` 和 `xfer doctor` 复核；`onPathMatches:false` 说明 shell 还指着旧副本。
- 本 skill 不复制参数表——参数以 `xfer -h` 为准，这样二进制升级时 skill 不必跟着改。

## 契约与边界

事件：`ready` · `warn` · `transfer` · `served` · `upload` · `denied(bad-token|cidr|limit|upload-size)`
· `blocked` · `download` · `verified` · `skip` · `done` · `error`。
退出码 `0/1/2`（成功/运行错误/用法错误）。

- 同一局域网才行；跨网必须隧道。
- 下载单向；上传只写进 `--upload` 目录。
- 明文 HTTP 只保证完整性（sha256），不保证机密；要机密就 TLS 或隧道。
- 二维码依赖系统 `qrencode`，没有就只打印 URL。
