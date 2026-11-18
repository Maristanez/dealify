FROM node:24-bookworm-slim AS build
RUN npm install --global pnpm@10.19.0 --ignore-scripts
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig*.json ./
COPY packages ./packages
COPY apps/server ./apps/server
COPY apps/web ./apps/web
RUN pnpm install --frozen-lockfile && pnpm build

FROM node:24-bookworm-slim AS runtime
RUN npm install --global pnpm@10.19.0 --ignore-scripts
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
COPY apps/server ./apps/server
COPY apps/web/package.json ./apps/web/package.json
RUN pnpm install --prod --frozen-lockfile
COPY --from=build /app/apps/web/dist ./apps/web/dist
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
CMD ["node", "apps/server/src/public-index.js"]
