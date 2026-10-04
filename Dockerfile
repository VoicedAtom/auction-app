FROM node:22-alpine
WORKDIR /app
COPY package.json server.js items.json ./
COPY public ./public
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data TRUST_PROXY=1
EXPOSE 3000
USER node
CMD ["node", "server.js"]
