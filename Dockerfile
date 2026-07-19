FROM node:22-slim

LABEL version="3.0" maintainer="expense-tracker"

RUN apt-get update && apt-get install -y python3 make g++ git curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src/ ./src/

RUN mkdir -p /app/data/wa-session

RUN useradd -r -u 1001 -g root appuser && chown -R appuser:root /app
USER appuser

EXPOSE 3000
CMD ["node", "src/index.js"]
