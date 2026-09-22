# MMBoard 术语表

| 项 | 值 |
|---|---|
| 版本 | v1.0 |
| 日期 | 2026-09-23 |
| 用途 | 统一文档与沟通中的项目专有名词;定义以代码实现为准(`server/*.cjs`) |

> 背景:外部自动索引(DeepWiki)已生成代码导航,但其术语覆盖不全(如缺失 `guardedFetch`、测试接口复用等验收核心概念)。本表为权威口径,新增术语先入此表。

## 任务与编号

| 术语 | 定义 |
|---|---|
| 展示编号(MT-YYYYMMDD-NNN) | 任务对外标识;日期段为 UTC 口径,序号由高水位保证**永不复用**(含删除后重启) |
| `dirKey` | 任务产物目录键(uuid);与展示编号解耦,旧数据回退编号(向后兼容) |
| 存储键(uuid) | 上传文件在 uploads/ 的唯一文件名;与 originalname 解耦,同名上传互相隔离 |
| `runId` | 任务每次执行的实例标识;所有状态写入前校验,不一致即 `RunSupersededError` 静默退出(取代机制) |
| 高水位(seq-highwater) | 持久化的"当日已分配最大序号";双坏 fail-closed,拒绝建任务防编号复用 |
| 串行队列 | 全局一次执行一个任务,容量 10;队满在写状态前同步拒绝(503) |
| runId 取代机制 | "重跑"生成新 runId 重新入队,旧实例绝不覆盖新状态/不写产物/不继续调 LLM |

## 转写

| 术语 | 定义 |
|---|---|
| 讯飞 lfasr | 讯飞云"录音文件转写"服务:签名 → 分片上传 → merge → 轮询;耗每日免费额度 |
| 本地 FunASR 工作机 | 独立 Python 服务(10.10.10.144:8300):自带队列/worker 转码/TTL 清理;免费转写 |
| 转写通道 | `iflytek \| local`,设置页切换,仅对新任务生效 |
| `transcriptionMode` | 任务档案字段:iflytek / local / **mock**——mock 仅演示模式,纪要全程标识 |
| `guardedFetch` | 本地 ASR 专用安全请求器:仅内网地址,DNS 解析校验私网 IP 后直连,重定向**逐跳**复验(≤3 跳),外网跳转直接拒绝;设置测试接口与执行路径共用 |
| 额度记账(quota) | 讯飞真实转写按音频秒数记账(本地自然日);本地转写与 mock 不记 |
| `assertQuotaReady` | 付费转写**前**的记账文件可读+可写检查;双坏则拒绝发起(不"先消耗后补记") |
| `quotaRecordFailed` | 转写成功但记账失败的显式任务标记;看板显示「额度未记账」 |

## LLM 分析

| 术语 | 定义 |
|---|---|
| 双协议 | OpenAI 兼容(`chat/completions`)与 Anthropic(`v1/messages`);多模型条目激活其一 |
| `allowedLlmHosts` | 内网 LLM 精确白名单(host 或 host:port);贯通保存/测试/执行;旧布尔开关已迁移删除 |
| `resolveLlmTarget` | LLM 地址安全解析:协议/元数据拒绝 → 白名单 → DNS 解析一次 → 私网校验 → 返回**绑定 IP** 的连接地址(保留 path/query 与 Host/SNI)——校验与连接同一 IP,无 rebinding 窗口 |
| `postJson` | LLM 原生请求器:不跟随重定向;空闲超时 20min、总截止 25min、响应上限 10MB |
| 分块提取(map/reduce) | >42000 字转写:按行边界切 30000 字块逐块提取(map,prompt 含该块**原文全文**)→ 头尾原文+块摘要汇总(reduce)——保证中段唯一决议进入纪要 |
| `chunkFailures` | 分块提取失败的结构化记录 `[{index, reason}]`;非空时强制 `partial=true` 并在纪要渲染「第 N 块提取失败」横幅 |
| `partial` | 结果完整性标记:LLM 截断/缺字段/分块失败任一为真;模板横幅提示,不冒充完整 |
| `normalizeAnalysis` | 输出规范化:类型纠正、缺失补空、计算 `missingFields`;模板对任何模型输出形状不崩溃 |
| `quoteState` / `trefState` | 行动项证据状态:verified/unverified/invalid/none;quote 只在 tref 重叠片段内核验;随 analysis.json 持久化 |
| canonical(说话人N) | 转写里的规范说话人标识;人工昵称(`speakerMap`)只在渲染层映射,永不回写底稿 |

## 可靠性与安全

| 术语 | 定义 |
|---|---|
| fail-closed | 损坏/异常时明确失败并给人工指引,绝不静默降级、回零或伪装成功 |
| 原子写(persist.cjs) | 临时文件(pid+随机)→ 复制 `.bak` → rename;Windows EPERM 自动重试;读取带 `.bak` 恢复与 `.corrupt` 隔离 |
| 双坏 | 主文件与 `.bak` 同时不可解析;额度/高水位双坏分别拒绝付费转写与建任务 |
| 四道防线(上传) | Content-Length 上限(413)→ 磁盘水位(503)→ 总配额含在途预留与本次大小(503)→ 媒体探测无音轨(400) |
| 预留账本 | 上传请求按 Content-Length 进程内预留(先检查后预留,两步间无 await);结束/中断释放;防并发共同越界 |
| 演示模式 | `MMB_DEMO=1` 或配置 `demo:true`;mock 仅属演示语义,非故障降级;非演示缺配置必须明确失败 |
| 版本四元组 | 功能提交 = GitHub 代码树 = 镜像 digest = 生产 `/api/version` 的追溯关系;GitHub HEAD 允许在其上的纯文档提交 |
| 候选容器隔离卷 | 发布时候选容器用生产数据卷的**快照**验证,绝不写生产数据;失败自动回滚 |
| `DEPLOY_DRILL` | 回滚演练模式:注入健康检查失败,验证自动回滚路径 |
| `scan:secrets` | 仓库密钥值扫描门禁:本机已知密钥值 vs 全部跟踪文件,零泄漏 |
