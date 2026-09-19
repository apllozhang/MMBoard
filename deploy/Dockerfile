# Symphony Console 全栈容器:Node 后端(流水线 + API)托管 dist 前端
# server/node_modules 由部署机打包带入(纯 JS 依赖,跨平台),镜像内不联网 npm 安装;
# ffmpeg 用 Alpine 源安装(视频抽音轨),换国内镜像源加速
FROM node:22-alpine
RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.aliyun.com/g' /etc/apk/repositories \
    && apk add --no-cache ffmpeg
WORKDIR /app/server
COPY server/node_modules ./node_modules
COPY server/package.json ./
COPY server/meeting.secret.json ./
COPY server/iflytek.cjs server/llm.cjs server/minutes-template.cjs server/pipeline.cjs server/server.cjs ./
COPY dist ../dist
COPY public/assets ../public/assets
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.cjs"]
