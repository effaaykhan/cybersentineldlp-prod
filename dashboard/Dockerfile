# Multi-stage build for production-ready Vite dashboard

# Stage 1: Build the application
FROM node:18-slim AS builder

WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./

# Install dependencies
RUN npm install

# Copy application source
COPY . .

# Accept build arguments for Vite environment variables
# VITE_API_URL intentionally defaults to empty so the app uses relative "/api/v1"
# paths at runtime, which the nginx reverse proxy forwards to the backend.
# Override only for non-proxied setups: --build-arg VITE_API_URL=http://host:55000/api/v1
ARG VITE_API_URL=
ARG VITE_WS_URL=
ARG VITE_APP_NAME=CyberSentinel DLP
ARG VITE_APP_VERSION=2.0.0

# Set environment variables for build
ENV NODE_ENV=production
ENV VITE_API_URL=${VITE_API_URL}
ENV VITE_WS_URL=${VITE_WS_URL}
ENV VITE_APP_NAME=${VITE_APP_NAME}
ENV VITE_APP_VERSION=${VITE_APP_VERSION}

# Build application
RUN npm run build

# Production image with nginx
FROM nginx:alpine AS runner

# Copy nginx configuration
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy built files
COPY --from=builder /app/dist /usr/share/nginx/html

# Expose port
EXPOSE 4000

# Run nginx
CMD ["nginx", "-g", "daemon off;"]
