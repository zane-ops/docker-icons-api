FROM oven/bun:1.2.21  as base
WORKDIR /app

# install APT dependencies
RUN apt update && apt install -y libglib2.0-0 \ 
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libxkbcommon0 \
    libatspi2.0-0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libcairo2 \
    libpango-1.0-0 \
    libasound2 \
    libnspr4 \
    libnss3 


# install dependencies
FROM base AS prod-deps
COPY ./package.json ./bun.lock ./

RUN bunx playwright install chromium --only-shell

RUN bun install --frozen-lockfile

# runtime
FROM base AS runtime
COPY --from=prod-deps /app/node_modules ./node_modules
COPY . .

ARG HOST=0.0.0.0
ARG PORT=3000

ENV HOST=${HOST}
ENV PORT=${PORT}

EXPOSE ${PORT}

CMD ["bun", "run", "index.ts"]