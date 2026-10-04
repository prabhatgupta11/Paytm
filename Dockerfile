FROM node:20-alpine

# Install openssl which Prisma needs on Alpine
RUN apk add --no-cache openssl

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies including Prisma
RUN npm install

# Copy Prisma schema and run generate
COPY prisma ./prisma/
RUN npx prisma generate

# Copy source code
COPY src/ ./src/

EXPOSE 3000

# Push the schema and start the app
CMD npx prisma db push --accept-data-loss && node src/index.js
