FROM node:24-slim
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter "@eyes/mcp..."
ENV HOST=0.0.0.0 PORT=3000 NODE_ENV=production
EXPOSE 3000
CMD ["node", "apps/mcp/src/main.ts"]
