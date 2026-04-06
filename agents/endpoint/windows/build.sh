#!/bin/bash
# Build script for CyberSentinel Windows Agent
# Run this in MSYS2 MinGW 64-bit terminal

echo "=========================================="
echo "CyberSentinel Agent Build Script"
echo "=========================================="
echo ""

# Check if we're in the right directory
if [ ! -f "agent.cpp" ]; then
    echo "ERROR: agent.cpp not found!"
    echo "Please run this script from the agents/endpoint/windows directory"
    exit 1
fi

# Backup old executable if it exists
if [ -f "cybersentinel_agent.exe" ]; then
    echo "Backing up existing executable..."
    cp cybersentinel_agent.exe cybersentinel_agent.exe.backup.$(date +%Y%m%d_%H%M%S)
    echo "✓ Backup created"
    echo ""
fi

echo "Compiling agent..."
echo "This may take 30-60 seconds..."
echo ""

# Compile the agent
g++ -std=c++17 -O2 \
    agent.cpp screen_capture_monitor.cpp print_monitor.cpp screen_recording_monitor.cpp \
    -o cybersentinel_agent.exe \
    -lwinhttp -lwbemuuid -lole32 -loleaut32 -luser32 -lgdi32 \
    -lws2_32 -lsetupapi -ladvapi32 -lcfgmgr32 -lshell32 -lwinspool -lpsapi -static

# Check if compilation was successful
if [ $? -eq 0 ]; then
    echo ""
    echo "=========================================="
    echo "✓ Compilation successful!"
    echo "=========================================="
    echo ""

    # Show file size
    SIZE=$(stat -c%s cybersentinel_agent.exe 2>/dev/null || stat -f%z cybersentinel_agent.exe 2>/dev/null)
    SIZE_MB=$(echo "scale=2; $SIZE / 1024 / 1024" | bc)

    echo "Executable: cybersentinel_agent.exe"
    echo "Size: ${SIZE_MB} MB"
    echo ""

    echo "New features in this build:"
    echo "  • Real-time content classification before blocking"
    echo "  • Only blocks files with sensitive data"
    echo "  • Fixed USB connection/disconnection alerts"
    echo "  • Enhanced logging with classification details"
    echo ""

    echo "Next steps:"
    echo "  1. Stop the Windows service:"
    echo "     Stop-Service CyberSentinelAgent -Force"
    echo ""
    echo "  2. Backup old executable:"
    echo "     Copy-Item \"C:\\Program Files\\CyberSentinel\\cybersentinel_agent.exe\" `"
    echo "               \"C:\\Program Files\\CyberSentinel\\cybersentinel_agent.exe.backup\""
    echo ""
    echo "  3. Copy new executable:"
    echo "     Copy-Item \"$(pwd)/cybersentinel_agent.exe\" `"
    echo "               \"C:\\Program Files\\CyberSentinel\\cybersentinel_agent.exe\" -Force"
    echo ""
    echo "  4. Start the service:"
    echo "     Start-Service CyberSentinelAgent"
    echo ""
else
    echo ""
    echo "=========================================="
    echo "✗ Compilation failed!"
    echo "=========================================="
    echo ""
    echo "Please check the error messages above."
    echo ""
    echo "Common issues:"
    echo "  • Make sure you're running this in MSYS2 MinGW 64-bit terminal"
    echo "  • Ensure g++ is installed: pacman -S mingw-w64-x86_64-gcc"
    echo "  • Check for syntax errors in agent.cpp"
    echo ""
    exit 1
fi
