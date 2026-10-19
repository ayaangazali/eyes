FROM node:26-slim
WORKDIR /app
RUN npm install -g pnpm@11.18.0
COPY . .
RUN pnpm install --frozen-lockfile --filter "@eyes/mcp..."
RUN pnpm --filter @eyes/mcp build
ENV HOST=0.0.0.0 PORT=3000 NODE_ENV=production
EXPOSE 3000
CMD ["node", "--no-experimental-webstorage", "apps/mcp/src/main.ts"]
