#!/bin/bash

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}"
echo "╔═══════════════════════════════════════════════════════════════╗"
echo "║                                                               ║"
echo "║            CyberSentinel DLP Installation Script             ║"
echo "║                                                               ║"
echo "║  Enterprise-Grade Data Loss Prevention Platform              ║"
echo "║                                                               ║"
echo "╚═══════════════════════════════════════════════════════════════╝"
echo -e "${NC}"
echo ""

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo -e "${RED}Error: Docker is not installed!${NC}"
    echo "Please install Docker first: https://docs.docker.com/get-docker/"
    exit 1
fi

# Check if Docker Compose is installed
if ! command -v docker compose &> /dev/null && ! command -v docker-compose &> /dev/null; then
    echo -e "${RED}Error: Docker Compose is not installed!${NC}"
    echo "Please install Docker Compose first: https://docs.docker.com/compose/install/"
    exit 1
fi

echo -e "${GREEN}✓ Docker and Docker Compose are installed${NC}"
echo ""

# Create installation directory
INSTALL_DIR="${HOME}/cybersentinel-dlp"
echo -e "${YELLOW}Creating installation directory: ${INSTALL_DIR}${NC}"
mkdir -p "${INSTALL_DIR}"
cd "${INSTALL_DIR}"

# Download docker-compose file
echo -e "${YELLOW}Downloading docker-compose.prod.yml...${NC}"
curl -fsSL https://raw.githubusercontent.com/effaaykhan/Data-Loss-Prevention/main/docker-compose.prod.yml -o docker-compose.yml

# Create .env file if it doesn't exist
if [ ! -f .env ]; then
    echo -e "${YELLOW}Creating .env file with default configuration...${NC}"
    cat > .env << EOF
# Database Passwords
POSTGRES_PASSWORD=CyberSentinel2025!
MONGODB_PASSWORD=CyberSentinel2025!
REDIS_PASSWORD=CyberSentinel2025!
OPENSEARCH_PASSWORD=CyberSentinel2025!

# JWT Secret (CHANGE THIS IN PRODUCTION!)
JWT_SECRET=$(openssl rand -hex 32)

# Environment
ENVIRONMENT=production
EOF
    echo -e "${GREEN}✓ .env file created${NC}"
    echo -e "${YELLOW}⚠ Please update passwords in ${INSTALL_DIR}/.env before deploying to production!${NC}"
else
    echo -e "${GREEN}✓ .env file already exists${NC}"
fi

echo ""
echo -e "${YELLOW}Pulling Docker images from GitHub Container Registry...${NC}"
docker compose pull

echo ""
echo -e "${YELLOW}Starting CyberSentinel DLP...${NC}"
docker compose up -d

echo ""
echo -e "${GREEN}✓ CyberSentinel DLP is starting up...${NC}"
echo ""
echo -e "${YELLOW}Waiting for services to be healthy (this may take 1-2 minutes)...${NC}"

# Wait for services to be healthy
sleep 30

# Check if manager is healthy
for i in {1..30}; do
    if docker compose ps | grep "cybersentinel-manager" | grep -q "healthy"; then
        echo -e "${GREEN}✓ Manager service is healthy${NC}"
        break
    fi
    echo -n "."
    sleep 2
done

echo ""
echo ""
echo -e "${GREEN}╔═══════════════════════════════════════════════════════════════╗"
echo "║                                                               ║"
echo "║            🎉 Installation Complete! 🎉                       ║"
echo "║                                                               ║"
echo "╚═══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${GREEN}CyberSentinel DLP is now running!${NC}"
echo ""
echo -e "${YELLOW}Access Points:${NC}"
echo "  📊 Dashboard:    http://localhost:4000"
echo "  🔌 API:          http://localhost:55000"
echo "  📖 API Docs:     http://localhost:55000/docs"
echo ""
echo -e "${YELLOW}Default Credentials:${NC}"
echo "  Username: admin@cybersentinel.local"
echo "  Password: admin123"
echo ""
echo -e "${YELLOW}Next Steps:${NC}"
echo "  1. Access the dashboard at http://localhost:4000"
echo "  2. Login with the default credentials"
echo "  3. Change the default password immediately"
echo "  4. Navigate to Settings to configure your organization"
echo "  5. Install agents on endpoints to start monitoring"
echo ""
echo -e "${YELLOW}Useful Commands:${NC}"
echo "  View logs:       cd ${INSTALL_DIR} && docker compose logs -f"
echo "  Stop services:   cd ${INSTALL_DIR} && docker compose down"
echo "  Start services:  cd ${INSTALL_DIR} && docker compose up -d"
echo "  Update:          cd ${INSTALL_DIR} && docker compose pull && docker compose up -d"
echo ""
echo -e "${YELLOW}Documentation:${NC}"
echo "  GitHub: https://github.com/effaaykhan/Data-Loss-Prevention"
echo ""
echo -e "${GREEN}Installation directory: ${INSTALL_DIR}${NC}"
echo ""
