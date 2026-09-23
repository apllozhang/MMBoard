# MMBoard 部署手册

| 项 | 值 |
|---|---|
| 版本 | v1.0(as-built) |
| 日期 | 2026-09-23 |
| 基线 | `7e55f94` |
| 关联 | 《配置与密钥管理》《应急预案与故障处理》《版本与发布管理》 |

## 1. 部署形态

| 项 | 值 |
|---|---|
| 生产主机 | 10.20.30.203(Docker;SSH 账号见 deploy.secret.json,不入库) |
| 容器 | `ale-symphony-console`;端口 8099;数据卷挂载容器内 `data/`;restart 常驻 |
| 镜像 | 每次发布由 deploy.cjs 现场构建(候选 `:cand` → 切换后为生产镜像);镜像 ID 不可变,回滚按 ID |
| 构建基座 | `deploy/Dockerfile`(Node 22;COPY 清单见文件,新增服务端文件必须同步加入) |

## 2. 一次发布(deploy.cjs 自动执行的全流程)

![发布与回滚流程](../diagrams/svg/06-发布与回滚流程.svg)

> 编辑源:`../diagrams/06-发布与回滚流程.drawio`(打开方式见 `../diagrams/README.md`)

```
node deploy/deploy.cjs          # 在开发机仓库根目录执行(DEPLOY_HOST/DEPLOY_PORT 可覆盖目标)
```

脚本内部步骤(每步失败即中止):

1. **打包**:tar 打包仓库(排除 node_modules、data、密钥文件、deploy 目录——部署包不含任何密钥);
2. **上传解压** → 生产机 `docker build` 候选镜像 `:cand`(退出码可靠,不用管道);
3. **候选容器试跑**:临时端口、**隔离数据卷快照**(`mmboard-cand-data`,用 alpine cp 从生产卷复制)——候选验证绝不写生产数据;
4. **健康检查**:`/api/version` 的 commit 必须等于本次发布 commit + `/api/auth/status` 可用;
5. **切换**:停删旧容器 → 用候选镜像按生产参数(端口+数据卷+restart)起正式容器 → 再验健康;
6. **失败自动回滚**:任一步失败,自动用切换前的镜像重启旧容器(旧镜像 ID 打印在日志,人工回退也可用)。

成功输出示例:`DEPLOY OK → http://10.20.30.203:8099/ (commit 7e55f94)`。

## 3. 发布前检查单

- [ ] `npm run typecheck`、`npm run build` 通过
- [ ] `node scripts/verify_batch_a.cjs` 全绿(182)
- [ ] `npm run scan:secrets` 通过
- [ ] 新增服务端文件已加入 `deploy/Dockerfile` COPY 清单
- [ ] 新增环境变量已登记《配置与密钥管理》§2 并在部署侧注入
- [ ] 涉及数据结构变更:确认旧数据兼容(启动不迁移即失败的设计不允许);文档同步
- [ ] 本次发布要点与影响写入提交说明(供回滚决策)

## 4. 回滚(手动)

```bash
# 生产机上(SSH):
docker stop ale-symphony-console && docker rm ale-symphony-console
docker run -d --name ale-symphony-console -p 8099:<容器端口> \
  -v <生产数据卷>:/app/data --restart unless-stopped \
  <回滚镜像ID>          # 回滚镜像 ID 见发布日志 / deploy.secret 同机的 docker images
curl -s http://127.0.0.1:8099/api/version   # 确认 commit 回到目标版本
```

数据卷不在回滚范围(镜像回滚不动数据);若发布包含**数据结构变更**,回滚前必须先确认旧镜像兼容新数据文件(本项目 JSON 结构均向后兼容,详见《数据设计说明》§9)。

## 5. 回滚演练(建议每次大版本前执行一次)

```bash
DEPLOY_DRILL=1 node deploy/deploy.cjs
```

演练模式注入"健康检查失败",验证:候选验证发现异常 → 自动回滚 → 生产仍运行旧版本。历史已执行一次(生产实测),报告见二轮交付文档。

## 6. 首次部署/新环境部署清单

1. 主机安装 Docker;创建部署账号;
2. 准备 `deploy.secret.json`(host/user/password;放规范目录,不入库);
3. 准备数据卷与目录(空目录即可,首次启动自动初始化);
4. 首次 `node deploy/deploy.cjs` → 启动日志取**一次性管理员口令**立即登录改密;
5. 设置页配置:LLM 模型(含内网白名单 `allowedLlmHosts`)、转写通道(讯飞密钥或本地 FunASR 地址);
6. 验证:`/api/version` 正常 → 上传测试音频走完流水线 → 下载纪要;
7. 把本次部署记录(镜像 ID、版本、日期)登记《版本与发布管理》台账。

## 7. 常见部署问题

| 现象 | 处理 |
|---|---|
| 候选健康检查失败(commit 不符) | 打包未含最新构建产物或 Dockerfile COPY 清单缺文件;检查后重发 |
| 切换后容器起不来 | `docker logs` 看启动错误(常见:数据卷权限/端口占用);按《应急预案》处理 |
| Windows 开发机 rename EPERM | persist.cjs 已内置重试;若仍出现说明有进程长期持有句柄,排查 |
| 部署后看板无任务 | 数据卷挂载错了路径——核对卷与 `data/` 的对应关系,**切勿**把空卷盖到生产卷上 |
