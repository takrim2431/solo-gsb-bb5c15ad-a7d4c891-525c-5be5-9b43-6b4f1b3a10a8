# ---- 构建阶段：安装依赖（优先预编译包，必要时现场编译 better-sqlite3） ----
FROM node:20-bookworm AS build
WORKDIR /app

# better-sqlite3 的预编译包从 GitHub Release 下载；构建机网络不通时回退到源码编译
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates curl xz-utils \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
COPY scripts ./scripts

# 先只装生产依赖；prebuild-install 失败会自动 node-gyp 编译（上面已装工具链）
RUN npm install --omit=dev --fetch-timeout=300000 || \
    (echo "npm install 失败，尝试直接拉取 better-sqlite3 预编译包" && \
     npm install --omit=dev --ignore-scripts && \
     node scripts/install-better-sqlite3.cjs)

# ---- 运行阶段 ----
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data

# better-sqlite3 是原生模块，运行时基本无额外依赖，wget 供健康检查
RUN apt-get update && apt-get install -y --no-install-recommends wget \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts

RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3000/api/health | grep -q '"ok":true' || exit 1

CMD ["node", "src/server.js"]
