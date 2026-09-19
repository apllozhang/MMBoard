# MMBoard — 会议纪要看板

按 [ALE WebUI 6.0.0 设计规范](https://github.com/apllozhang/webui)实现的会议纪要工作流系统：导入录音/录像 → 讯飞语音转写 → GLM AI 分析 → 生成 ALE 规范样式的单文件纪要 HTML。

## 功能

- **看板**：上传（拖拽/选择）、流水线状态四色卡、任务 14A 数据表格（排序/列宽拖拽/筛选/分页）、流水线时间线详情、失败重跑
- **流水线**：导入 → 抽音轨（ffmpeg，音频直传）→ 语音转写（讯飞录音文件转写/mock）→ AI 分析（OpenAI 兼容或 Anthropic 协议/mock）→ 纪要渲染（ALE 令牌、双主题、版本徽章、商标行）
- **纪要产物**：单文件 HTML，深度分析章节（亮点/逐人优点/缺点复盘/对比总览/建议）按内容自动启用，320/768/1440 零溢出

## 快速开始

```bash
npm install                      # 前端依赖
(cd server && npm install)       # 后端依赖
npm run build                    # 构建前端
cd server && node server.cjs     # 启动（8787，同时托管 API 与前端）
```

密钥配置：复制 `server/meeting.secret.example.json` 为 `server/meeting.secret.json`，按需填讯飞（APPID + SecretKey）与 LLM（支持 anthropic/openai 双协议）；缺哪项哪项走模拟数据。

部署：`DEPLOY_PORT=<port> node deploy/deploy.cjs`（需规范仓库 kit/tools 的 ssh2 与 deploy.secret.json）。

## 验证

```bash
node scripts/verify.mjs <base> <outdir>   # 18 项浏览器断言（渲染/交互/字体）
cd ../repo/kit/tools && npm run pilot:tokens:check -- <src路径> symphony-console   # 硬编码颜色扫描
```

## 技术栈

React 18 + TypeScript + Tailwind（ALE 预设）+ TanStack Table · Node/Express（零构建 CJS）· ffmpeg · 讯飞 lfasr 四步协议 · GLM/Anthropic Messages 协议
