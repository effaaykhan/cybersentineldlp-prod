/**
 * CyberSentinel DLP Minifilter - Shared Header
 *
 * Shared between kernel driver and user-mode service.
 * Defines communication structures for the filter port.
 */

#ifndef _CSFILTER_H_
#define _CSFILTER_H_

/* ────────────────────────────────────────────────────────────────────────────
 * Communication Port Names
 * ──────────────────────────────────────────────────────────────────────────── */

#define CS_FILTER_PORT_NAME     L"\\CyberSentinelPort"
#define CS_FILTER_DRIVER_NAME   L"CyberSentinelFilter"

/* ────────────────────────────────────────────────────────────────────────────
 * Limits
 * ──────────────────────────────────────────────────────────────────────────── */

#define CS_MAX_PATH             520
#define CS_MAX_VOLUME_NAME      64
#define CS_MAX_SID_LENGTH       128
#define CS_MAX_PROCESS_NAME     260

/* ────────────────────────────────────────────────────────────────────────────
 * Event Types (kernel → usermode)
 * ──────────────────────────────────────────────────────────────────────────── */

typedef enum _CS_EVENT_TYPE {
    CsEventFileCreate       = 1,
    CsEventFileWrite        = 2,
    CsEventFileRename       = 3,
    CsEventFileDelete       = 4,
    CsEventUsbArrival       = 10,
    CsEventUsbRemoval       = 11,
} CS_EVENT_TYPE;

/* ────────────────────────────────────────────────────────────────────────────
 * Device Type Flags (bitmask)
 * ──────────────────────────────────────────────────────────────────────────── */

typedef enum _CS_DEVICE_FLAGS {
    CsDeviceFixed           = 0x0001,
    CsDeviceRemovable       = 0x0002,
    CsDeviceNetwork         = 0x0004,
    CsDeviceOptical         = 0x0008,
    CsDeviceVirtual         = 0x0010,
    CsDeviceUnknown         = 0x8000,
} CS_DEVICE_FLAGS;

/* ────────────────────────────────────────────────────────────────────────────
 * Decision (usermode → kernel)
 * ──────────────────────────────────────────────────────────────────────────── */

typedef enum _CS_DECISION {
    CsDecisionAllow         = 0,
    CsDecisionBlock         = 1,
    CsDecisionWarn          = 2,   /* Allow but notify user */
} CS_DECISION;

/* ────────────────────────────────────────────────────────────────────────────
 * Message: Kernel → Usermode (event notification)
 * ──────────────────────────────────────────────────────────────────────────── */

#pragma pack(push, 1)

typedef struct _CS_EVENT_MESSAGE {
    /* Header */
    ULONG           MessageId;
    CS_EVENT_TYPE   EventType;
    LARGE_INTEGER   Timestamp;

    /* Process context */
    ULONG           ProcessId;
    ULONG           ThreadId;
    WCHAR           ProcessName[CS_MAX_PROCESS_NAME];

    /* User context */
    WCHAR           UserSid[CS_MAX_SID_LENGTH];

    /* File context */
    WCHAR           FilePath[CS_MAX_PATH];
    LONGLONG        FileSize;
    ULONG           FileAttributes;

    /* Volume/device context */
    WCHAR           VolumeName[CS_MAX_VOLUME_NAME];
    CS_DEVICE_FLAGS DeviceFlags;

    /* Rename-specific (valid when EventType == CsEventFileRename) */
    WCHAR           NewFilePath[CS_MAX_PATH];

    /* Flags */
    ULONG           IsDirectory : 1;
    ULONG           IsPreOperation : 1;
    ULONG           NeedsDecision : 1;
    ULONG           Reserved : 29;

} CS_EVENT_MESSAGE, *PCS_EVENT_MESSAGE;

/* ────────────────────────────────────────────────────────────────────────────
 * Reply: Usermode → Kernel (enforcement decision)
 * ──────────────────────────────────────────────────────────────────────────── */

typedef struct _CS_DECISION_REPLY {
    ULONG           MessageId;      /* Must match the event's MessageId */
    CS_DECISION     Decision;
    ULONG           ReasonCode;     /* 0 = policy match, 1 = classification, etc. */
} CS_DECISION_REPLY, *PCS_DECISION_REPLY;

#pragma pack(pop)

#endif /* _CSFILTER_H_ */
