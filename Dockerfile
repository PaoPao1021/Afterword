FROM node:24-bookworm-slim
ENV NODE_ENV=production PORT=3210 HOST=0.0.0.0 CET6_DATA_PATH=/app/data/cet6.sqlite
WORKDIR /app
COPY --chown=node:node package.json server.js ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node public ./public
COPY --chown=node:node scripts ./scripts
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3210
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "require('node:http').get('http://127.0.0.1:3210/healthz',{headers:{Host:new URL(process.env.AFTERWORD_PUBLIC_ORIGIN).host},signal:AbortSignal.timeout(3000)},r=>{r.resume();process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"
CMD ["node", "server.js"]
