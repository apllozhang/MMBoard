# 架构与流程图(diagrams)

源文件为 draw.io 格式(`.drawio`),是文档配图的**唯一编辑源**。查看/编辑方式任选:

- VS Code:安装 "Draw.io Integration" 插件后直接打开;
- 桌面版 draw.io / https://app.diagrams.net :File → Open(选本地文件);
- 命令行批量导出 SVG/PNG(可选):`drawio -x -f svg <文件>`(需安装 drawio CLI)。

| 文件 | 内容 | 被引用于 |
|---|---|---|
| 01-系统架构与部署拓扑.drawio | 浏览器/容器八模块/数据卷/三个外部服务及安全通道 | 《总体架构设计》§1 |
| 02-任务状态机.drawio | queued→…→done/failed 状态机、重跑与新 runId 取代 | 《详细设计说明书》§1 |
| 03-端到端任务流水线.drawio | 上传→防线→转写双通道→分析(分块/单次)→校验→渲染 全流程 | 《总体架构设计》§4.1 |
| 04-上传四道防线.drawio | 上传前检查链、预留账本与各拒绝码、清理动作 | 《详细设计说明书》§7 |
| 05-LLM分块与完整性保障.drawio | >42000 字分块 map/reduce、chunkFailures→强制 partial→模板横幅 | 《详细设计说明书》§3.3 |
| 06-发布与回滚流程.drawio | deploy.cjs 打包→候选隔离卷→健康检查→切换/自动回滚 | 《部署手册》§2 |

约定:改图先改 `.drawio` 源文件,再同步更新引用它的文档;新增图在本表登记。
