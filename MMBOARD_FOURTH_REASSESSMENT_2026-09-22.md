# MMBoard 第四轮独立整改复审报告

> 复审日期：2026-09-22  
> 复审依据：`MMBOARD_THIRD_REASSESSMENT_2026-09-22.md`、`MMBOARD_交付复审_三轮_2026-09-22.md`  
> 功能代码提交：`8e03f66`  
> GitHub `main`：`711a098`（仅文档提交）  
> 生产版本：`8e03f66`

## 1. 结论

本轮大部分整改有真实运行证据，R17 讯飞分类重试和 R23 浏览器矩阵可以关闭。但交付材料中的 R13 分块提取存在确定实现错误和测试假阳性，真实 FunASR 压测脚本也无法在当前工作区或全新 clone 按默认命令复现。R05、R09、R15、R18 仍有影响原验收目标的缺口。

R01–R25 状态：

- **PASS：17 项**：R01、R02、R03、R04、R06、R07、R08、R10、R11、R14、R16、R17、R20、R21、R22、R23、R25。
- **PARTIAL：7 项**：R05、R09、R12、R15、R18、R19、R24。
- **FAIL：1 项**：R13。

当前最优先修复的是 R13。它会让超长会议的中段内容没有发送给模型，直接违背本轮声称解决的“中段唯一决议可提取”。

## 2. 版本核对

| 对象 | 实测值 | 结论 |
|---|---|---|
| 本地/GitHub HEAD | `711a0982aa0ba11cd876cb851eea4432209d6a38` | 仅文档提交 |
| 生产 `/api/version` | `8e03f66` | 功能提交 |
| `8e03f66..HEAD` 代码目录 diff | 空 | 生产代码树与功能提交一致 |
| 生产构建时间 | `2026-09-22T14:30:30.03Z` | 与交付材料一致 |

版本口径成立。

## 3. 测试复现结果

| 命令 | 结果 |
|---|---|
| `npm run scan:secrets` | 通过：276 个跟踪文件、4 个本机凭据值、零匹配泄漏 |
| `node scripts/verify_batch_a.cjs` | 126/126 通过，但 R13 的 5 项断言是假阳性，见第 4.1 节 |
| `python scripts/regression_batch1.py` | 30/30 通过 |
| `python tools/local-asr/test_server.py` | 11/11 通过；控制台中文乱码，不影响断言 |
| `node scripts/browser_matrix.mjs` | 13/13 通过 |
| `node scripts/funasr_load_test.cjs` | **失败**：健康检查成功后，读取缺失的 `_funasr_t1.wav` 报 ENOENT |
| 生产 `/api/version` | 返回 `8e03f66` |

真实 FunASR 服务本轮只验证了 `/health`：HTTP 200、`ok=true`、模型已加载、响应约 9ms。串行转写和并发三任务没有执行。

## 4. 关键发现

### 4.1 P1：R13 分块提取没有把分块文本发送给 LLM

`server/llm.cjs:225-229` 的 `mapChunk(chunk, ...)` 虽然接收了 `chunk` 参数，但构造的 prompt 只有说明和 JSON schema，没有加入 `${chunk}`：

```js
const prompt = `以下是一段超长会议转写的第 ${idx}/${total} 块。请只输出一个 JSON...
{"decisions": [...], "actions": [...], "notes": [...]}`;
```

因此模型根本看不到对应会议分块。后续 reduce 只能得到模型在没有原文时生成的内容，超长会议中段仍被实际丢失。

现有测试为什么会通过：`scripts/verify_batch_a.cjs:96-104` 的 chunk stub 不检查 prompt 是否包含实际分块内容，而是看到“第 2/2 块”后直接生成 `CHUNK-DECISION-MARK-2`。这个标记恰好与测试埋入原文的标记同名，造成“中段决议已提取”的假象。

**裁定：R13 FAIL。**

**修复要求：**

1. 把完整 `chunk` 明确加入 map prompt，并控制 prompt 总预算。
2. 测试 stub 只有在收到的 prompt 中真实存在唯一标记时才能回传该标记。
3. 增加否定断言：第一块 prompt 不含第二块标记，第二块 prompt 必须含标记。
4. 测试 map 失败、空响应、残缺 JSON 及三块以上会议。

### 4.2 P1：R05 的设置测试接口仍绕过新 SSRF 防线

真实 LLM 执行路径和 `server/local.cjs` 已增加 IP 绑定和逐跳重定向验证，这是有效改进。但设置测试接口仍是旧路径：

- `server/server.cjs:395-417` 先调用 `assertLlmUrl`，随后用原始 `base` 再次 `fetch`。真实连接会重新解析 DNS并自动跟随重定向，DNS rebinding 和重定向绕过仍存在。
- 此处没有把 `allowedLlmHosts` 传给校验器，只读取旧的 `allowPrivateLlmHosts` 布尔值。精确白名单中的内网模型可能无法测试，启用旧布尔值后又会全量放开。
- `server/server.cjs:461-479` 的 `/api/settings/test-asr` 也直接对原始 URL 使用默认 `fetch`，没有复用 `guardedFetch`，同样会自动跟随重定向。

交付测试只直接测试了 `localAsr.guardedFetch`，没有通过两个真实设置 API 测试，所以没有发现旁路。

**裁定：R05 PARTIAL，不接受 CLOSED。**

对“本地 ASR 保留整个私网 CIDR”的裁定：可以作为产品默认发现范围保留，但不能据此把 R05 关闭。至少应提供可配置的本地 ASR 主机/端口列表，并让测试接口和任务执行共用完全相同的请求函数。旧 `allowPrivateLlmHosts=true` 全放行兼容开关应迁移后删除。

### 4.3 R09 额度损坏仍没有真正 fail-closed

高水位文件主备损坏会拒绝创建任务，analysis/transcript 已改为原子写，均为有效整改。但真实讯飞转写后的额度记录仍有旁路：

`server/pipeline.cjs:358-364` 捕获 `recordQuota` 的所有异常，只记录“额度记账失败（不影响任务）”并继续完成任务。主备额度文件损坏时，测试直接调用 `recordQuota` 的确会抛错，但真实流水线会吞掉该错误，继续消耗转写服务且不记额度。

**裁定：R09 PARTIAL。** 应在额度状态不可读时，在调用付费转写前拒绝任务，或把任务标为需要人工处理；不能先调用转写再忽略记账失败。

### 4.4 R15 的 quote 与 tref 没有相互绑定

当前实现能够识别不存在的 quote 和完全不与任何 segment 重叠的 tref，属于有效改进。但 `verifyActionEvidence` 分别执行：

- quote 是否出现在整篇转写任意位置；
- tref 是否与任意 segment 重叠。

它没有验证 quote 是否出现在 tref 对应的 segment 内。模型可以引用会议开头的真实句子，同时给出会议末尾的合法时间范围，两项仍都会被标记 `verified`。

**裁定：R15 PARTIAL。** 应先按 tref 选择重叠 segments，再只在这些 segments 的文本中核验 quote；同时校验 `from < to` 和时间范围没有超出音频边界。

### 4.5 R18 总配额和媒体探测仍存在资源边界

已完成 Content-Length 预检、磁盘水位检查、媒体音轨检查和基础总量统计。但：

- `quotaExceeded()` 只判断当前占用是否 `>` 配额，没有把本次上传的 Content-Length 加入计算。当前占用略低于配额时，仍可一次超过配额最多约 2GB。
- 占用缓存最长 60 秒，并发上传会同时看到旧值，进一步突破总配额。
- `probeHasMediaStream()` 使用同步 `execFileSync`，单次可阻塞 Node 事件循环最多 20 秒。多个恶意或缓慢媒体探测可影响所有接口。
- chunked 请求没有 Content-Length 时只能等 Multer 的 2GB 限制，在此之前仍会消耗磁盘和带宽。

**裁定：R18 PARTIAL。** 应预留本次上传容量、使用并发安全的配额计数，并把 ffprobe 移到异步受控 worker；代理层补充请求体和速率限制。

### 4.6 R19 真实 FunASR 压测不可复现

`scripts/funasr_load_test.cjs:14,70` 默认读取仓库根目录 `_funasr_t1.wav`，该文件未提交也不存在。脚本注释允许通过 `FUNASR_WAV` 注入，但交付文档声称“五套脚本全新 clone 即可复现”，与实际不符。

本轮运行结果：健康检查两项通过，然后在第一次上传前报 ENOENT。交付材料中的 8/8 结果可能来自开发方本地音频，但没有可复现输入和结果工件。

**裁定：R19 PARTIAL、R24 PARTIAL。** 应提交体积合理、授权清晰的语音测试夹具，或由脚本自行生成含已知文本的 TTS 音频；脚本必须在缺少夹具时给出明确准备说明，交付文档不得称全新 clone 默认可运行。

## 5. 已确认关闭的本轮项目

### R17：PASS

讯飞 stub 经真实 HTTP 覆盖 prepare/upload/merge/轮询：

- 5xx 两次后恢复并成功；
- 业务码 26601 立即失败且不重试；
- 持续瞬态失败达到上限后明确报错；
- 轮询请求带次数日志。

分类重试、上限和退避策略满足原验收核心目标。

### R23：PASS

Playwright 13 项全部通过，覆盖双 Dialog、inert/aria-hidden、Esc、Tab 焦点循环、键盘 Enter、进度条 ARIA、320px、420px 和页面 JS 异常。320px 横向滚动缺陷的修复有真实 Chromium 行为证据。

NVDA/VoiceOver 实机听读仍是建议项，不阻止本轮 R23 通过。

## 6. R01–R25 状态矩阵

| 项 | 结论 | 说明 |
|---|---|---|
| R01 | PASS | 维持。 |
| R02 | PASS | UUID 目录键和高水位机制已验证。 |
| R03 | PASS | 维持。 |
| R04 | PASS | 维持。 |
| R05 | PARTIAL | 执行路径改善；两个设置测试 API 仍绕过 IP 绑定和逐跳验证。 |
| R06 | PASS | 维持。 |
| R07 | PASS | 维持。 |
| R08 | PASS | 维持。 |
| R09 | PARTIAL | 原子写改善；真实流水线仍吞掉额度记账损坏错误。 |
| R10 | PASS | 维持。 |
| R11 | PASS | 维持。 |
| R12 | PARTIAL | 凭据轮换按用户决定未执行，镜像层扫描未成为 CI 强制。 |
| R13 | FAIL | map prompt 未包含 chunk，测试 stub 按块编号伪造同名标记。 |
| R14 | PASS | 维持。 |
| R15 | PARTIAL | quote 与 tref 分别验证，没有验证二者对应同一原文片段。 |
| R16 | PASS | 维持。 |
| R17 | PASS | 讯飞分类重试有真实 HTTP stub 证据。 |
| R18 | PARTIAL | 总配额不含本次上传、缓存存在并发超额窗口、同步 ffprobe 阻塞事件循环。 |
| R19 | PARTIAL | stub 测试通过且真实服务健康；真实负载脚本缺少音频夹具，转写压测未复现。 |
| R20 | PASS | 维持。 |
| R21 | PASS | 维持。 |
| R22 | PASS | 维持。 |
| R23 | PASS | Playwright 13/13，关闭。 |
| R24 | PARTIAL | 浏览器矩阵已补；R13 用例假阳性，真实 FunASR 套件默认不可运行。 |
| R25 | PASS | 维持。 |

## 7. 下一轮最小整改清单

1. 修复 R13：把真实 chunk 放入 map prompt，并重写 stub，使响应严格依赖收到的原文标记。
2. 修复 R05：`/api/settings/test` 与 `/api/settings/test-asr` 必须复用生产执行路径的安全请求器；移除旧全放行开关。
3. 修复 R09：额度文件不可恢复时，在付费转写前 fail-closed，不得吞掉记账错误。
4. 修复 R15：在 tref 对应 segments 内核验 quote，并验证时间范围方向与边界。
5. 修复 R18：配额判断加入本次上传大小，解决并发预留，把 ffprobe 改为异步 worker。
6. 修复 R19/R24：提供可合法分发的真实语音夹具或脚本生成夹具，确保全新 clone 默认命令可运行。

完成后请提供上述失败/边界用例的实际运行输出，不要继续使用按块编号直接返回预期标记的测试 stub。

