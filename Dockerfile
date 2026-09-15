FROM node:20-alpine AS base
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src

EXPOSE 3001
CMD ["node", "src/index.js"]
