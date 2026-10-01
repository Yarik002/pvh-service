# =====================================================================
#  Сборка образа приложения «Сервис трекинга заказов и инвентаря для ПВЗ».
#
#  Образ основан на node:22 (LTS). Зависимости ставятся через pnpm
#  со строгой фиксацией версий из pnpm-lock.yaml: структура node_modules
#  задаётся параметром nodeLinker: hoisted в файле pnpm-workspace.yaml,
#  поэтому каталог получается «плоским» и не содержит символических ссылок.
#
#  Сборка:   docker build -t pvh-service .
#  Запуск:   docker compose up --build
# =====================================================================

FROM node:22-slim

# Локаль русская: нужна для корректной работы SQLite с текстовыми данными
ENV LANG=C.UTF-8

# Каталог приложения
WORKDIR /app

# --- Зависимости ------------------------------------------------------
# Сначала копируются только файлы описания зависимостей: пока они
# не меняются, слой с установленными пакетами берётся из кеша и сборка
# проходит быстро.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./

# corepack включает pnpm той версии, что зафиксирована в проекте
RUN corepack enable \
 && corepack prepare pnpm@latest --activate \
 && pnpm install --frozen-lockfile --prod

# --- Исходный код -----------------------------------------------------
COPY . .

# --- Параметры запуска ------------------------------------------------
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
# Каталог для файла базы данных SQLite
ENV DB_FILE=/app/data/pvh.db

# Каталог данных создаётся заранее. Права на него выравнивает сценарий
# запуска: содержимое тома может принадлежать суперпользователю, а сервер
# работает от непривилегированной учётной записи node.
RUN mkdir -p /app/data \
 && cp docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh \
 && chmod +x /usr/local/bin/docker-entrypoint.sh \
 && chown -R node:node /app/data

EXPOSE 3000

# Проверка работоспособности: сервер должен отвечать на /health
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Сценарий запуска применяет миграции, создаёт начальные данные
# и запускает сервер от имени пользователя node
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

