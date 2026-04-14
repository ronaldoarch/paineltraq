FROM node:20-alpine

RUN apk add --no-cache tini

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev

COPY . .

RUN mkdir -p logs && chmod +x scripts/docker-entrypoint.sh

ENV NODE_ENV=production

# Coolify costuma usar PORT=3000; compose local costuma 3001
EXPOSE 3000 3001

HEALTHCHECK --interval=20s --timeout=5s --start-period=120s --retries=5 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health/live',(r)=>{r.resume();r.on('end',()=>process.exit(r.statusCode===200?0:1));}).on('error',()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["scripts/docker-entrypoint.sh"]
