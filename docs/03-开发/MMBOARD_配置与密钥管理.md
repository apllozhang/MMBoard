# MMBoard 配置与密钥管理

| 项 | 值 |
|---|---|
| 文档状态 | ✅ 成文(已按《文档库质量提升指导》核对) |
| 适用功能版本 | `7e55f94` |
| 最近核对日期 | 2026-09-23 |
| 维护责任人 | 待指定(项目方) |
| 事实依据 | server/server.cjs loadSecret、server/meeting.secret.example.json、deploy/deploy.secret 字段 |
| 版本 | v1.0(as-built) |
| 日期 | 2026-09-23 |
| 基线 | `7e55f94` |
| 关联 | 《项目移交清单》(凭据移交与轮换确认)、《部署手册》(环境变量) |

## 1. 密钥与配置的存放边界

| 载体 | 内容 | 是否入库 |
|---|---|---|
| `server/meeting.secret.json` | 回退密钥(LLM/讯飞),兼容既有部署 | ❌ 永不入库(.gitignore;提供 `meeting.secret.example.json` 模板) |
| `repo/deploy.secret.json` | 部署 SSH 凭据(host/user/password) | ❌ 永不入库(位于仓库外的规范目录) |
| `data/settings.json`(生产卷) | 模型条目 apiKey、讯飞 key/secret(服务端明文存储) | ❌ 在数据卷内,不进代码库与部署包 |
| 环境变量 | `MMB_ADMIN_PASSWORD`、`MMB_DEMO` 等 | 部署时注入,不入库 |
| 仓库/文档 | 任何文档、日志、测试 | ❌ `npm run scan:secrets` 门禁校验 |

**铁律**:密钥只出现在上述三处;界面回显一律打码(`sk-ab****wxyz`);提交打码值 = 不修改。

## 2. 环境变量清单

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 8099(生产) | HTTP 端口 |
| `MMB_DATA_DIR` | `server/data` | 数据目录(测试必设,隔离到临时目录) |
| `MMB_ADMIN_PASSWORD` | 自动生成一次性随机 | 首次初始化管理员口令 |
| `MMB_DEMO` | 未设 | `=1` 演示模式(缺配置走 mock;真实通道亦按 mock 处理) |
| `MMB_MIN_FREE_BYTES` | 1GB | 磁盘剩余水位 |
| `MMB_UPLOADS_QUOTA_BYTES` | 20GB | uploads 总配额 |
| `MMB_USAGE_CACHE_MS` | 60000 | 占用求和缓存(测试设 0) |
| `MMB_FFPROBE_CONCURRENCY` | 2 | ffprobe 探测并发上限 |
| `IFLYTEK_API_BASE` / `IFLYTEK_POLL_MS` / `IFLYTEK_POLL_RETRY_MAX` / `IFLYTEK_POLL_TIMEOUT_MS` | 讯飞正式地址 / 5000 / 5 / 30min | 讯飞接口注入(测试 stub 用) |

## 3. 各密钥的用途与配置位置

| 密钥 | 用途 | 配置入口 |
|---|---|---|
| LLM `apiKey` | 纪要分析(OpenAI 兼容或 Anthropic 协议) | 设置页「模型管理」或 meeting.secret.json(回退) |
| 讯飞 `appId + apiSecret` | 云转写 lfasr 签名(apiKey 可选) | 设置页「转写通道」或 meeting.secret.json(回退) |
| 本地 ASR 地址 | 免费转写工作机(非密钥,属配置) | 设置页「转写通道·本地」 |
| 部署 SSH 口令 | deploy.cjs 连接生产主机 | deploy.secret.json |
| 管理员口令 | 登录 | 首次初始化 / 修改口令接口 |

内网 LLM 服务(如本机 Ollama)额外要求:主机加入 `allowedLlmHosts` 白名单(host 或 host:port,如 `127.0.0.1:11434`),保存/测试/执行共用。

## 4. 打码与防外送设计

- 设置 GET:apiKey/apiSecret 打码回显;PUT 提交含 `****` = 沿用旧值;
- **修改了 baseUrl 必须重输明文密钥**(防止把旧密钥发往新地址);讯飞 key/secret 同口径;
- 密钥不进日志:审计日志只记操作与掩码结果;错误信息不含密钥。

## 5. 演示模式边界(R06)

`MMB_DEMO=1` 或设置 `demo:true` 时:转写与分析走确定性 mock,任务与纪要全程醒目标识"演示模拟数据"。**非演示模式下缺配置必须明确失败**(拒绝静默 mock)——mock 只属于演示语义,不属于故障降级。

## 6. 凭据轮换流程(待办,移交前必须完成)

> 当前状态:**未执行**(集中整改期按项目方决策与代码验收分离)。**前提**:获得项目方授权、安排在无会议使用时段、提前完成一次数据卷备份(见《运维手册》§2);**影响范围**:旧凭据作废后,正在执行的讯飞/LLM 任务会明确失败(重传即可),已完成的任务与纪要不受影响;回退方式:在服务商控制台恢复旧凭据并同步更新设置页。

| 步骤 | 操作 | 验证 |
|---|---|---|
| 1. 讯飞 | 在讯飞控制台重置 apiSecret(必要时同步 apiKey) | 设置页更新 → 保存 → 上传真实音频转写成功;额度记账正常 |
| 2. LLM | 在模型服务商控制台重置 apiKey,作废旧 key | 设置页更新激活模型密钥 → 「测试」通过 → 真实任务分析成功 |
| 3. SSH | 在 10.20.30.203 重置部署账号口令(或改为密钥登录,推荐) | 更新 deploy.secret.json → `node deploy/deploy.cjs` 走一次演练(`DEPLOY_DRILL=1`)成功 |
| 4. 管理员口令 | 登录后改密(强口令) | 旧口令 401,新口令登录正常 |
| 5. 清理残留 | 删除工作目录中的明文凭据便签(如 `登录.txt`)与旧密钥副本 | `npm run scan:secrets` 通过;目录无明文凭据 |
| 6. 留痕 | 在《项目移交清单》勾选轮换确认项,记录执行日期与执行人 | — |

轮换期间注意:旧 key 作废后,尚未完成的历史任务不受影响;正在执行的任务如遇 401/签名失败会明确失败,重新上传即可。

## 7. 泄漏应急

发现疑似泄漏(误提交/误发):立即在服务商侧作废该密钥 → 按 §6 轮换 → 排查访问日志(讯飞控制台用量、LLM 账单)→ 仓库侧用 `git filter-repo` 清历史(需协调所有克隆方)→ 事故记录归档到《风险登记册》。
