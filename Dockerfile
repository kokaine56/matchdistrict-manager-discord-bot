# MatchDistrict Manager Discord Bot Dockerfile
FROM node:22-alpine

WORKDIR /app

# Update system packages for security and install tini for proper SIGINT/SIGTERM handling
RUN apk update && apk upgrade --no-cache && apk add --no-cache tini

# Copy package files first for efficient Docker layer caching
COPY package*.json ./

# Install only production dependencies
RUN npm install --omit=dev --ignore-scripts && npm cache clean --force

# Copy application source code
COPY . ./

# Runtime environment
ENV NODE_ENV=production

# Expose port for health checks if deployed as a Web Service on Render / Railway
EXPOSE 10000

# Use tini as init process to properly forward signals
ENTRYPOINT ["/sbin/tini", "--"]

# Start the Discord bot
CMD ["node", "index.js"]
