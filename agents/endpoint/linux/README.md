# CyberSentinel DLP - Linux Agent

Enterprise endpoint DLP agent for Linux systems.

## Features

- ✅ **File System Monitoring** - Real-time inotify-based monitoring
- ✅ **Automatic Classification** - Pattern-based sensitive data detection
- ✅ **Real-time Reporting** - Sends events to central server
- ✅ **Systemd Integration** - Runs as system service
- ✅ **Low Resource Usage** - Optimized for servers

## Requirements

- Ubuntu 20.04+ / CentOS 8+ / Debian 11+
- Python 3.8+
- Root privileges (for installation)

## Quick Installation

```bash
# Clone or download agent files
cd agents/endpoint/linux

# Make installer executable
chmod +x install.sh

# Run installer
sudo ./install.sh
```

## Manual Installation

```bash
# Install dependencies
sudo apt-get install python3 python3-pip
pip3 install -r requirements.txt

# Create directories
sudo mkdir -p /opt/cybersentineldlp
sudo mkdir -p /etc/cybersentineldlp

# Copy files
sudo cp agent.py /opt/cybersentineldlp/
sudo cp agent_config.json /etc/cybersentineldlp/
sudo cp cybersentineldlp-agent.service /etc/systemd/system/

# Start service
sudo systemctl daemon-reload
sudo systemctl enable cybersentineldlp-agent
sudo systemctl start cybersentineldlp-agent
```

## Configuration

Edit `/etc/cybersentineldlp/agent_config.json`:

```json
{
  "server_url": "http://YOUR-SERVER-IP:8000/api/v1",
  "agent_name": "YOUR-AGENT-NAME",
  "monitoring": {
    "monitored_paths": [
      "/home",
      "/var/www"
    ]
  }
}
```

After editing, restart the agent:
```bash
sudo systemctl restart cybersentineldlp-agent
```

## Usage

### Start Agent
```bash
sudo systemctl start cybersentineldlp-agent
```

### Stop Agent
```bash
sudo systemctl stop cybersentineldlp-agent
```

### Check Status
```bash
sudo systemctl status cybersentineldlp-agent
```

### View Logs
```bash
# Real-time logs
sudo journalctl -u cybersentineldlp-agent -f

# Last 100 lines
sudo journalctl -u cybersentineldlp-agent -n 100

# Log file
sudo tail -f /var/log/cybersentineldlp_agent.log
```

## Monitored Events

| Event Type | Description |
|------------|-------------|
| **File Created** | New file created in monitored directories |
| **File Modified** | File content changed |
| **File Moved** | File moved or renamed |

## Sensitive Data Detection

The agent detects:
- Credit Card Numbers (PAN)
- Social Security Numbers (SSN)
- Email Addresses
- API Keys and Secrets
- Private Keys (RSA, DSA, EC)
- Passwords in configuration files

## Troubleshooting

### Check if agent is running
```bash
sudo systemctl status cybersentineldlp-agent
ps aux | grep agent.py
```

### Agent won't start
```bash
# Check logs
sudo journalctl -u cybersentineldlp-agent -n 50

# Check configuration
sudo cat /etc/cybersentineldlp/agent_config.json

# Test connectivity
curl http://YOUR-SERVER-IP:8000/health
```

### Permission errors
```bash
# Ensure proper permissions
sudo chown -R root:root /opt/cybersentineldlp
sudo chmod +x /opt/cybersentineldlp/agent.py
```

### High CPU usage
- Reduce monitored paths
- Exclude cache directories
- Increase file size limit in config

## Uninstallation

```bash
# Stop and disable service
sudo systemctl stop cybersentineldlp-agent
sudo systemctl disable cybersentineldlp-agent

# Remove files
sudo rm /etc/systemd/system/cybersentineldlp-agent.service
sudo rm -rf /opt/cybersentineldlp
sudo rm -rf /etc/cybersentineldlp

# Reload systemd
sudo systemctl daemon-reload
```

## Performance

- **CPU Usage**: <1% idle, 2-5% during activity
- **Memory**: ~50-100MB RAM
- **Disk I/O**: Minimal (event-driven)
- **Network**: <1KB/s average

## Security

- Agent runs as root (required for file monitoring)
- All events sent over HTTPS (if configured)
- Configuration file protected (600 permissions)
- No sensitive data stored locally

## Support

For issues or questions:
- Check logs: `/var/log/cybersentineldlp_agent.log`
- System logs: `sudo journalctl -u cybersentineldlp-agent`
- Review server logs

## Version

**Version**: 1.0.0
**Platform**: Linux (Ubuntu, Debian, CentOS, RHEL)
**Last Updated**: January 2025
