FROM node:20-alpine

RUN apk add --no-cache tzdata
ENV TZ=Asia/Ho_Chi_Minh

WORKDIR /app

COPY package.json package-lock.json* ./

RUN npm install --production --no-fund --no-audit \
    && npm cache clean --force

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
ENV NODE_OPTIONS="--max-old-space-size=512"

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD wget -q -O- http://localhost:${PORT}/ || exit 1

CMD ["node", "main.js"]
