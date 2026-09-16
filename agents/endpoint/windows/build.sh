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
if [ -f "cybersentineldlp_agent.exe" ]; then
    echo "Backing up existing executable..."
    cp cybersentineldlp_agent.exe cybersentineldlp_agent.exe.backup.$(date +%Y%m%d_%H%M%S)
    echo "✓ Backup created"
    echo ""
fi

# ── Version ───────────────────────────────────────────────────────────────
# One number, set by hand in ./VERSION, compiled into the binary and reported to
# the server as the agent version. Bump it in the same commit as any agent
# source change; CI fails the build if you forget, so a version number always
# names exactly one binary.
VERSION_FILE="VERSION"
if [ ! -f "$VERSION_FILE" ]; then
    echo "ERROR: $VERSION_FILE not found — the agent version has no source of truth."
    exit 1
fi
AGENT_VER="$(tr -d ' \t\r\n' < "$VERSION_FILE")"
case "$AGENT_VER" in
    [0-9]*.[0-9]*.[0-9]*) : ;;
    *) echo "ERROR: VERSION must be MAJOR.MINOR.PATCH, got '${AGENT_VER}'"; exit 1 ;;
esac

echo "Version: ${AGENT_VER}"
echo ""

# Win32 VERSIONINFO, so File Properties -> Details and
# (Get-Item agent.exe).VersionInfo.ProductVersion report the version WITHOUT
# running the agent — the question an admin asks about a file on disk.
# FILEVERSION wants four comma-separated numbers, so pad the semver with a 0.
VER_COMMAS="$(echo "$AGENT_VER" | tr '.' ',')",0
RC_OBJ=""
if command -v windres >/dev/null 2>&1; then
    # NO application manifest. It was added and is taken back out.
    #
    # A manifest was tried as a way to give the unsigned binary some identity
    # against the Bearfoos ML detection. It was not asked for, it did not
    # address the detection, and it put runtime behaviour at risk for nothing:
    # SetProcessDpiAwarenessContext fails with ERROR_ACCESS_DENIED when the
    # process DPI awareness has already been fixed, and a manifest is one of the
    # things that fixes it. EnsureDpiAwareness runs first in main() precisely
    # because mouse-hook coordinates and UI Automation rectangles have to be
    # measured in the same space - lose that and Enter still blocks (no
    # coordinates involved) while the Send BUTTON stops being hit-tested, which
    # is exactly what was reported after this shipped.
    #
    # The version-resource additions below are kept: they are file metadata with
    # no runtime effect whatsoever.
    cat > version.rc <<RC
1 VERSIONINFO
FILEVERSION    ${VER_COMMAS}
PRODUCTVERSION ${VER_COMMAS}
FILEFLAGSMASK  0x3fL
FILEFLAGS      0x0L
FILEOS         0x40004L
FILETYPE       0x1L
FILESUBTYPE    0x0L
BEGIN
  BLOCK "StringFileInfo"
  BEGIN
    BLOCK "040904b0"
    BEGIN
      VALUE "CompanyName",      "CyberSentinel"
      VALUE "FileDescription",  "CyberSentinel DLP Endpoint Agent"
      VALUE "FileVersion",      "${AGENT_VER}"
      VALUE "InternalName",     "cybersentineldlp_agent"
      VALUE "LegalCopyright",   "Copyright (C) CyberSentinel. All rights reserved."
      VALUE "OriginalFilename", "cybersentineldlp_agent.exe"
      VALUE "ProductName",      "CyberSentinel DLP Agent"
      VALUE "ProductVersion",   "${AGENT_VER}"
      VALUE "Comments",         "Endpoint data-loss-prevention agent. Monitors and enforces organisational DLP policy on this device."
    END
  END
  BLOCK "VarFileInfo"
  BEGIN
    VALUE "Translation", 0x409, 1200
  END
END
RC
    if windres version.rc -O coff -o version.o 2>/dev/null; then
        RC_OBJ="version.o"
    else
        echo "WARNING: windres failed — exe will carry no file-properties version"
    fi
else
    echo "WARNING: windres not found — exe will carry no file-properties version"
fi

echo "Compiling agent..."
echo "This may take 30-60 seconds..."
echo ""

# Compile the agent
# -mwindows links the GUI subsystem, so Windows never allocates a console for
# this process at all. The agent already hid its console at startup, but hiding
# one is not the same as never having one: with a console subsystem binary the
# window exists for the moment between CreateProcess and ShowWindow, which is
# the flash a user sees at every logon. It is also why the installer used to
# wrap the exe in a .vbs, and that wrapper is what Application Control blocks.
#
# Safe here because nothing depends on stdout: the agent logs to a file, and
# its console writes are already conditional on a visible console window
# (agent.cpp, Log()). mingw-w64 supplies the WinMain shim, so main() is
# untouched.
g++ -std=c++17 -O2 -mwindows \
    -DAGENT_VERSION_STR="\"${AGENT_VER}\"" \
    agent.cpp screen_capture_monitor.cpp print_monitor.cpp network_exfil_monitor.cpp \
    messaging_text_monitor.cpp ${RC_OBJ} \
    -o cybersentineldlp_agent.exe \
    -lwinhttp -lwbemuuid -lole32 -loleaut32 -luser32 -lgdi32 \
    -lws2_32 -lsetupapi -ladvapi32 -lcfgmgr32 -lshell32 -lwinspool \
    -luiautomationcore -lpsapi -lmpr -lwtsapi32 -static

# Check if compilation was successful
BUILD_RC=$?
rm -f version.rc version.o
if [ $BUILD_RC -eq 0 ]; then
    echo ""
    echo "=========================================="
    echo "✓ Compilation successful! (v${AGENT_VER})"
    echo "=========================================="
    echo ""

    # Show file size (pure shell - no bc dependency)
    SIZE=$(stat -c%s cybersentineldlp_agent.exe 2>/dev/null || stat -f%z cybersentineldlp_agent.exe 2>/dev/null)
    if [ -n "$SIZE" ]; then
        SIZE_MB=$(( SIZE / 1024 / 1024 ))
        SIZE_KB_REM=$(( (SIZE / 1024) % 1024 ))
        printf "Executable: cybersentineldlp_agent.exe\n"
        printf "Size: %d.%02d MB (%d bytes)\n" "$SIZE_MB" "$(( SIZE_KB_REM * 100 / 1024 ))" "$SIZE"
    else
        echo "Executable: cybersentineldlp_agent.exe"
    fi
    echo ""

    echo "Features in this build:"
    echo "  • Clipboard / USB / Screenshot / Print monitoring (existing)"
    echo "  • Real-time content classification before blocking"
    echo "  • Network Exfiltration Monitor (NEW):"
    echo "      - curl / wget / PowerShell / bitsadmin / certutil: BLOCKING"
    echo "      - Python script-based transfers: BEST-EFFORT detection"
    echo "      - Browser (chrome/msedge/firefox) file-dialog: ALERT ONLY"
    echo ""

    echo "=========================================="
    echo "Deployment (PowerShell as Administrator)"
    echo "=========================================="
    echo ""
    echo "NOTE: The agent runs as a Scheduled Task named"
    echo "      \"CyberSentinel DLP Agent\" (not a Windows service)."
    echo ""
    echo "  1. Stop the scheduled task (prevents auto-restart):"
    echo "     Stop-ScheduledTask -TaskName \"CyberSentinel DLP Agent\""
    echo ""
    echo "  2. Kill any remaining agent process:"
    echo "     Stop-Process -Name \"cybersentineldlp_agent\" -Force -ErrorAction SilentlyContinue"
    echo ""
    echo "  3. Verify no agent process is running:"
    echo "     Get-Process -Name \"cybersentineldlp_agent\" -ErrorAction SilentlyContinue"
    echo "     (output should be empty)"
    echo ""
    echo "  4. Backup the current binary:"
    echo "     Copy-Item \"C:\\Program Files\\CyberSentinelDLP\\cybersentineldlp_agent.exe\" \`"
    echo "               \"C:\\Program Files\\CyberSentinelDLP\\cybersentineldlp_agent.exe.backup\" -Force"
    echo ""
    echo "  5. Copy the newly built binary into place:"
    echo "     Copy-Item \"$(pwd)/cybersentineldlp_agent.exe\" \`"
    echo "               \"C:\\Program Files\\CyberSentinelDLP\\cybersentineldlp_agent.exe\" -Force"
    echo ""
    echo "  6. (Optional) Ensure heartbeat_interval is set to 3 in the config:"
    echo "     notepad \"C:\\Program Files\\CyberSentinelDLP\\agent_config.json\""
    echo ""
    echo "  7. Start the scheduled task:"
    echo "     Start-ScheduledTask -TaskName \"CyberSentinel DLP Agent\""
    echo ""
    echo "  8. Verify exactly ONE process is running:"
    echo "     Get-Process -Name \"cybersentineldlp_agent\""
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
