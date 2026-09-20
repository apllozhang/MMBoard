# Symphony Console 全栈容器:Node 后端(流水线 + API)托管 dist 前端
# server/node_modules 由部署机打包带入(纯 JS 依赖,跨平台),镜像内不联网 npm 安装;
# ffmpeg 用 Alpine 源安装(视频抽音轨),换国内镜像源加速
# ⚠ R12:密钥不进镜像——meeting.secret.json 由数据卷(/app/server/data)提供,
#   server.cjs 优先读数据卷内副本,回退旧位置(存量部署兼容)
FROM node:22-alpine
RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.aliyun.com/g' /etc/apk/repositories \
    && apk add --no-cache ffmpeg
WORKDIR /app/server
COPY server/node_modules ./node_modules
COPY server/package.json ./
COPY server/iflytek.cjs server/llm.cjs server/minutes-template.cjs server/pipeline.cjs server/local.cjs server/auth.cjs server/server.cjs ./
COPY dist ../dist
COPY public/assets ../public/assets
COPY vendor ../vendor
# R10/R11:构建元信息注入(部署脚本传 build-arg,/api/version 回显)
ARG GIT_COMMIT=unknown
ARG BUILD_TIME=unknown
ENV GIT_COMMIT=${GIT_COMMIT} BUILD_TIME=${BUILD_TIME}
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.cjs"]
