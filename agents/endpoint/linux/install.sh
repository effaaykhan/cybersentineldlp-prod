#!/bin/bash
# CyberSentinel DLP - Linux Agent Installer

set -e

echo "============================================"
echo "CyberSentinel DLP - Linux Agent Installer"
echo "============================================"
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo "ERROR: Please run as root (sudo)"
    exit 1
fi

# Install Python dependencies
echo "[1/5] Installing Python dependencies..."
apt-get update -qq
apt-get install -y python3 python3-pip -qq
pip3 install -r requirements.txt -q

# Create installation directory
echo "[2/5] Creating installation directory..."
mkdir -p /opt/cybersentineldlp
mkdir -p /etc/cybersentineldlp
mkdir -p /var/log

# Copy files
echo "[3/5] Installing agent..."
cp agent.py /opt/cybersentineldlp/
cp agent_config.json /etc/cybersentineldlp/
chmod +x /opt/cybersentineldlp/agent.py

# Install systemd service
echo "[4/5] Installing systemd service..."
cp cybersentineldlp-agent.service /etc/systemd/system/
systemctl daemon-reload

# Enable and start service
echo "[5/5] Starting agent..."
systemctl enable cybersentineldlp-agent
systemctl start cybersentineldlp-agent

echo ""
echo "============================================"
echo "✓ Installation complete!"
echo "============================================"
echo ""
echo "Agent Status:"
systemctl status cybersentineldlp-agent --no-pager -l
echo ""
echo "Useful Commands:"
echo "  View logs:    journalctl -u cybersentineldlp-agent -f"
echo "  Stop agent:   sudo systemctl stop cybersentineldlp-agent"
echo "  Start agent:  sudo systemctl start cybersentineldlp-agent"
echo "  Agent status: sudo systemctl status cybersentineldlp-agent"
echo ""
echo "Configuration: /etc/cybersentineldlp/agent_config.json"
echo "Logs: /var/log/cybersentineldlp_agent.log"
echo ""
