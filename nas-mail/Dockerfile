FROM node:20-alpine

WORKDIR /app

# Install dependencies first (layer cache)
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Copy source
COPY src ./src

# Drop privileges
RUN addgroup -S app && adduser -S app -G app
USER app

EXPOSE 3000

ENV NODE_ENV=production

CMD ["node", "src/server.js"]
