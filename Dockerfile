FROM node:20-alpine

WORKDIR /usr/src/app

# Install production dependencies with deterministic caching
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copy Oracle server
COPY server.js ./

# Ensure persistent ratings file exists with non-root ownership
RUN touch ratings.json && chown -R node:node /usr/src/app

USER node

EXPOSE 8080

CMD ["node", "server.js"]