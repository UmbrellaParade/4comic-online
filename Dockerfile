FROM node:24-slim

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY . .

ENV ONLINE_MODE=true
ENV HOST=0.0.0.0
ENV DATA_DIR=/data
VOLUME ["/data"]

EXPOSE 8787
CMD ["npm", "start"]
