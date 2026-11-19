FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src/ ./src/
COPY etl/ ./etl/

EXPOSE 3010

CMD ["node", "src/server.js"]
