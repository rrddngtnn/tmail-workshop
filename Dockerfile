FROM node:26-bookworm-slim
WORKDIR /app
RUN mkdir /data && chown node:node /data && chmod 700 /data
COPY --chown=node:node apps/vps/server.mjs apps/vps/server.mjs
COPY LICENSE LICENSE
USER node
ENV TMAIL_DB_PATH=/data/mail.sqlite TMAIL_HOST=0.0.0.0 TMAIL_PORT=3000
EXPOSE 3000
CMD ["node", "apps/vps/server.mjs"]
