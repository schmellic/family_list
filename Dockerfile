FROM node:22-alpine
WORKDIR /app
COPY package.json server.js make-admin.js ./
COPY public ./public
ENV PORT=3000 DB_PATH=/data/wishlist.db
VOLUME /data
EXPOSE 3000
USER node
CMD ["node", "server.js"]
