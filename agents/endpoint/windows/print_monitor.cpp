#include "print_monitor.h"
#include <iostream>
#include <sstream>

#pragma comment(lib, "winspool.lib")

PrintMonitor::PrintMonitor(PrintCallback callback) : m_callback(std::move(callback)) {}

PrintMonitor::~PrintMonitor() { Stop(); }

bool PrintMonitor::Start() {
    if (m_running) return true;

    // Open local print server
    HANDLE hPrinter = NULL;
    PRINTER_DEFAULTS defaults = {NULL, NULL, PRINTER_ALL_ACCESS};

    if (!OpenPrinter(NULL, &hPrinter, &defaults)) {
        // Fallback: monitor with reduced permissions
        if (!OpenPrinter(NULL, &hPrinter, NULL)) {
            std::cerr << "[PrintMonitor] Failed to open print server: " << GetLastError() << std::endl;
            return false;
        }
    }

    // Set up change notification
    DWORD filter = PRINTER_CHANGE_ADD_JOB | PRINTER_CHANGE_SET_JOB | PRINTER_CHANGE_DELETE_JOB;
    m_changeNotification = FindFirstPrinterChangeNotification(hPrinter, filter, 0, NULL);

    if (m_changeNotification == INVALID_HANDLE_VALUE) {
        ClosePrinter(hPrinter);
        std::cerr << "[PrintMonitor] Failed to create change notification: " << GetLastError() << std::endl;
        return false;
    }

    ClosePrinter(hPrinter);
    m_running = true;
    m_thread = std::thread(&PrintMonitor::MonitorLoop, this);

    std::cout << "[PrintMonitor] Started monitoring print jobs" << std::endl;
    return true;
}

void PrintMonitor::Stop() {
    m_running = false;
    if (m_changeNotification != INVALID_HANDLE_VALUE) {
        FindClosePrinterChangeNotification(m_changeNotification);
        m_changeNotification = INVALID_HANDLE_VALUE;
    }
    if (m_thread.joinable()) {
        m_thread.join();
    }
}

bool PrintMonitor::IsRunning() const { return m_running; }

void PrintMonitor::MonitorLoop() {
    while (m_running) {
        DWORD waitResult = WaitForSingleObject(m_changeNotification, 2000);

        if (!m_running) break;

        if (waitResult == WAIT_OBJECT_0) {
            DWORD change = 0;
            FindNextPrinterChangeNotification(m_changeNotification, &change, NULL, NULL);

            if (change & PRINTER_CHANGE_ADD_JOB) {
                // Enumerate printers to find new jobs
                DWORD needed = 0, count = 0;
                EnumPrinters(PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS, NULL, 2, NULL, 0, &needed, &count);

                if (needed > 0) {
                    std::vector<BYTE> buffer(needed);
                    PRINTER_INFO_2* printers = reinterpret_cast<PRINTER_INFO_2*>(buffer.data());

                    if (EnumPrinters(PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS, NULL, 2, buffer.data(), needed, &needed, &count)) {
                        for (DWORD i = 0; i < count; i++) {
                            if (printers[i].cJobs > 0) {
                                // Get job info
                                HANDLE hPrinter = NULL;
                                if (OpenPrinter(printers[i].pPrinterName, &hPrinter, NULL)) {
                                    DWORD jobNeeded = 0, jobCount = 0;
                                    EnumJobs(hPrinter, 0, printers[i].cJobs, 1, NULL, 0, &jobNeeded, &jobCount);

                                    if (jobNeeded > 0) {
                                        std::vector<BYTE> jobBuffer(jobNeeded);
                                        JOB_INFO_1* jobs = reinterpret_cast<JOB_INFO_1*>(jobBuffer.data());

                                        if (EnumJobs(hPrinter, 0, printers[i].cJobs, 1, jobBuffer.data(), jobNeeded, &jobNeeded, &jobCount)) {
                                            for (DWORD j = 0; j < jobCount; j++) {
                                                std::string printerName = printers[i].pPrinterName ? printers[i].pPrinterName : "Unknown";
                                                std::string docName = jobs[j].pDocument ? jobs[j].pDocument : "Unknown";
                                                std::string userName = jobs[j].pUserName ? jobs[j].pUserName : "Unknown";
                                                int pages = jobs[j].TotalPages;

                                                if (m_callback) {
                                                    m_callback(printerName, docName, pages, userName);
                                                }
                                            }
                                        }
                                    }
                                    ClosePrinter(hPrinter);
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
