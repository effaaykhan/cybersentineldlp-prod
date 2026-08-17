"""
Web activity control — the shared vocabulary for granular activity enforcement.

The requirement this exists for is per-*activity* control, not per-destination
control::

    Webmail          — upload, download, attach, send
    Cloud storage    — upload, download, post
    Collaboration    — upload, download, post
    Generative AI    — post (AI prompt / "generate"), ai_response, attach,
                       upload, download

Before this module the product could answer "is this host a cloud app?" and
nothing else: every interception was a file upload, so *what the user was doing*
had no representation anywhere in the system. Two dimensions were missing —
which CATEGORY of app the destination is, and which ACTIVITY is being performed
— and both are defined here once so the policy engine, the evaluate endpoint,
the event pipeline and the browser extension cannot drift apart.

WHY THE CATALOG IS DATA, NOT CODE: the GenAI vendor list changes monthly. The
old ``CLOUD_HOSTS`` array lived inside the extension's inject.js, so adding a
vendor meant editing JavaScript, re-signing and redeploying the extension to
every endpoint. ``app_catalog`` rows are pulled by the extension at runtime, so
adding one is an insert. The bundled defaults below are the *seed* and the
offline fallback, never the authority.
"""
from __future__ import annotations

from typing import Dict, List, Optional, Tuple

# ── Categories ───────────────────────────────────────────────────────────────
CATEGORY_WEBMAIL = "webmail"
CATEGORY_CLOUD = "cloud_storage"
CATEGORY_COLLABORATION = "collaboration"
CATEGORY_GENAI = "genai"

CATEGORIES: Tuple[str, ...] = (
    CATEGORY_WEBMAIL,
    CATEGORY_CLOUD,
    CATEGORY_COLLABORATION,
    CATEGORY_GENAI,
)

CATEGORY_LABELS: Dict[str, str] = {
    CATEGORY_WEBMAIL: "Webmail",
    CATEGORY_CLOUD: "File Sharing / Cloud Storage",
    CATEGORY_COLLABORATION: "Collaboration",
    CATEGORY_GENAI: "Generative AI",
}

# ── Activities ───────────────────────────────────────────────────────────────
# "post" covers the requirement's "AI Post" / "generate" / "Post" — submitting
# content into the app. It is deliberately one verb: from the endpoint's point
# of view pressing Send in Slack and pressing Enter in ChatGPT are the same
# gesture with the same payload, and splitting them would produce two policy
# rows that must always be set identically.
ACTIVITY_UPLOAD = "upload"
ACTIVITY_DOWNLOAD = "download"
ACTIVITY_ATTACH = "attach"
ACTIVITY_SEND = "send"
ACTIVITY_POST = "post"
ACTIVITY_AI_RESPONSE = "ai_response"

ACTIVITIES: Tuple[str, ...] = (
    ACTIVITY_UPLOAD,
    ACTIVITY_DOWNLOAD,
    ACTIVITY_ATTACH,
    ACTIVITY_SEND,
    ACTIVITY_POST,
    ACTIVITY_AI_RESPONSE,
)

ACTIVITY_LABELS: Dict[str, str] = {
    ACTIVITY_UPLOAD: "Upload",
    ACTIVITY_DOWNLOAD: "Download",
    ACTIVITY_ATTACH: "Attach",
    ACTIVITY_SEND: "Send",
    ACTIVITY_POST: "Post / Generate",
    ACTIVITY_AI_RESPONSE: "AI Response",
}

# Which activities are meaningful for which category. The matrix UI and the
# policy validator both use this so an operator is never offered "AI Response
# on Webmail", and a policy carrying such a row is ignored rather than silently
# treated as matching everything.
CATEGORY_ACTIVITIES: Dict[str, Tuple[str, ...]] = {
    CATEGORY_WEBMAIL: (ACTIVITY_UPLOAD, ACTIVITY_DOWNLOAD, ACTIVITY_ATTACH, ACTIVITY_SEND),
    CATEGORY_CLOUD: (ACTIVITY_UPLOAD, ACTIVITY_DOWNLOAD, ACTIVITY_POST),
    CATEGORY_COLLABORATION: (ACTIVITY_UPLOAD, ACTIVITY_DOWNLOAD, ACTIVITY_POST),
    CATEGORY_GENAI: (
        ACTIVITY_UPLOAD,
        ACTIVITY_DOWNLOAD,
        ACTIVITY_ATTACH,
        ACTIVITY_POST,
        ACTIVITY_AI_RESPONSE,
    ),
}

# ── Actions ──────────────────────────────────────────────────────────────────
ACTION_ALLOW = "allow"
ACTION_LOG = "log"
ACTION_ALERT = "alert"
ACTION_BLOCK = "block"

ACTIONS: Tuple[str, ...] = (ACTION_ALLOW, ACTION_LOG, ACTION_ALERT, ACTION_BLOCK)

# Rank for collapsing several matching rules into one effective action. Mirrors
# ``policy_transformer._ACTION_RANK`` so the endpoint and the dashboard never
# disagree about what a policy does.
ACTION_RANK: Dict[str, int] = {
    ACTION_ALLOW: 0,
    ACTION_LOG: 1,
    ACTION_ALERT: 2,
    ACTION_BLOCK: 3,
}

# ── Event types ──────────────────────────────────────────────────────────────
# One event_type per category so existing per-type reporting, domain stamping
# and SIEM mapping keep working. "web_activity" is the umbrella used when the
# category itself is unknown.
CATEGORY_EVENT_TYPE: Dict[str, str] = {
    CATEGORY_WEBMAIL: "email",
    CATEGORY_CLOUD: "cloud_upload",
    CATEGORY_COLLABORATION: "collaboration",
    CATEGORY_GENAI: "genai",
}


def event_type_for(category: Optional[str]) -> str:
    return CATEGORY_EVENT_TYPE.get(_norm(category), "web_activity")


def _norm(value: Optional[str]) -> str:
    return str(value or "").strip().lower()


def normalize_category(value: Optional[str]) -> Optional[str]:
    """Canonical category name, or None when unrecognised.

    Accepts the aliases a caller might reasonably send ("cloud", "ai",
    "chat") so an extension built against an older vocabulary still lands on
    the right row rather than falling out of policy entirely.
    """
    v = _norm(value)
    if not v:
        return None
    if v in CATEGORIES:
        return v
    aliases = {
        "mail": CATEGORY_WEBMAIL,
        "email": CATEGORY_WEBMAIL,
        "web_mail": CATEGORY_WEBMAIL,
        "cloud": CATEGORY_CLOUD,
        "storage": CATEGORY_CLOUD,
        "file_sharing": CATEGORY_CLOUD,
        "filesharing": CATEGORY_CLOUD,
        "collab": CATEGORY_COLLABORATION,
        "chat": CATEGORY_COLLABORATION,
        "messaging": CATEGORY_COLLABORATION,
        "ai": CATEGORY_GENAI,
        "gen_ai": CATEGORY_GENAI,
        "generative_ai": CATEGORY_GENAI,
        "llm": CATEGORY_GENAI,
    }
    return aliases.get(v)


def normalize_activity(value: Optional[str]) -> Optional[str]:
    """Canonical activity name, or None when unrecognised."""
    v = _norm(value)
    if not v:
        return None
    if v in ACTIVITIES:
        return v
    aliases = {
        "generate": ACTIVITY_POST,
        "ai_post": ACTIVITY_POST,
        "prompt": ACTIVITY_POST,
        "submit": ACTIVITY_POST,
        "message": ACTIVITY_POST,
        "response": ACTIVITY_AI_RESPONSE,
        "ai_reply": ACTIVITY_AI_RESPONSE,
        "completion": ACTIVITY_AI_RESPONSE,
        "attachment": ACTIVITY_ATTACH,
        "share": ACTIVITY_UPLOAD,
        "put": ACTIVITY_UPLOAD,
        "get": ACTIVITY_DOWNLOAD,
        "export": ACTIVITY_DOWNLOAD,
        "mail_send": ACTIVITY_SEND,
    }
    return aliases.get(v)


def normalize_action(value: Optional[str], default: str = ACTION_LOG) -> str:
    v = _norm(value)
    return v if v in ACTIONS else default


def is_valid_pair(category: Optional[str], activity: Optional[str]) -> bool:
    """Is this activity meaningful for this category? See CATEGORY_ACTIVITIES."""
    c = normalize_category(category)
    a = normalize_activity(activity)
    if not c or not a:
        return False
    return a in CATEGORY_ACTIVITIES.get(c, ())


# ── Bundled catalog seed ─────────────────────────────────────────────────────
#
# (host_pattern, app_id, app_name, vendor, category)
#
# host_pattern matches the hostname exactly OR as a suffix after a dot, i.e.
# "google.com" matches "drive.google.com" but not "notgoogle.com". Same rule the
# extension's isCloudUrl() used, kept deliberately so migrating the old
# hardcoded CLOUD_HOSTS list into rows changes no behaviour.
#
# The GenAI block is the part that did not exist anywhere in the product before:
# a repo-wide search for any AI vendor hostname returned nothing, so a user
# pasting a customer list into ChatGPT produced no event of any kind.
DEFAULT_CATALOG: List[Tuple[str, str, str, str, str]] = [
    # ── Webmail ──
    ("mail.google.com", "gmail", "Gmail", "Google", CATEGORY_WEBMAIL),
    ("outlook.live.com", "outlook_web", "Outlook Web", "Microsoft", CATEGORY_WEBMAIL),
    ("outlook.office.com", "outlook_web", "Outlook Web", "Microsoft", CATEGORY_WEBMAIL),
    ("outlook.office365.com", "outlook_web", "Outlook Web", "Microsoft", CATEGORY_WEBMAIL),
    ("mail.yahoo.com", "yahoo_mail", "Yahoo Mail", "Yahoo", CATEGORY_WEBMAIL),
    ("mail.proton.me", "proton_mail", "Proton Mail", "Proton", CATEGORY_WEBMAIL),
    ("protonmail.com", "proton_mail", "Proton Mail", "Proton", CATEGORY_WEBMAIL),
    ("mail.zoho.com", "zoho_mail", "Zoho Mail", "Zoho", CATEGORY_WEBMAIL),
    ("mail.rediff.com", "rediffmail", "Rediffmail", "Rediff", CATEGORY_WEBMAIL),
    # ── Cloud storage / file sharing ──
    ("drive.google.com", "google_drive", "Google Drive", "Google", CATEGORY_CLOUD),
    ("docs.google.com", "google_docs", "Google Docs", "Google", CATEGORY_CLOUD),
    ("googleapis.com", "google_apis", "Google APIs", "Google", CATEGORY_CLOUD),
    ("googleusercontent.com", "google_upload", "Google Upload", "Google", CATEGORY_CLOUD),
    ("dropbox.com", "dropbox", "Dropbox", "Dropbox", CATEGORY_CLOUD),
    ("dropboxapi.com", "dropbox", "Dropbox", "Dropbox", CATEGORY_CLOUD),
    ("dropboxusercontent.com", "dropbox", "Dropbox", "Dropbox", CATEGORY_CLOUD),
    ("onedrive.live.com", "onedrive", "OneDrive", "Microsoft", CATEGORY_CLOUD),
    ("1drv.ms", "onedrive", "OneDrive", "Microsoft", CATEGORY_CLOUD),
    ("sharepoint.com", "sharepoint", "SharePoint", "Microsoft", CATEGORY_CLOUD),
    ("box.com", "box", "Box", "Box", CATEGORY_CLOUD),
    ("boxcloud.com", "box", "Box", "Box", CATEGORY_CLOUD),
    ("wetransfer.com", "wetransfer", "WeTransfer", "WeTransfer", CATEGORY_CLOUD),
    ("mega.nz", "mega", "MEGA", "MEGA", CATEGORY_CLOUD),
    ("mediafire.com", "mediafire", "MediaFire", "MediaFire", CATEGORY_CLOUD),
    ("icloud.com", "icloud", "iCloud", "Apple", CATEGORY_CLOUD),
    ("amazonaws.com", "aws_s3", "Amazon S3", "Amazon", CATEGORY_CLOUD),
    ("wasabisys.com", "wasabi", "Wasabi", "Wasabi", CATEGORY_CLOUD),
    ("pcloud.com", "pcloud", "pCloud", "pCloud", CATEGORY_CLOUD),
    ("sync.com", "sync_com", "Sync.com", "Sync", CATEGORY_CLOUD),
    ("terabox.com", "terabox", "TeraBox", "TeraBox", CATEGORY_CLOUD),
    ("file.io", "file_io", "File.io", "File.io", CATEGORY_CLOUD),
    ("anonfiles.com", "anonfiles", "AnonFiles", "AnonFiles", CATEGORY_CLOUD),
    ("gofile.io", "gofile", "GoFile", "GoFile", CATEGORY_CLOUD),
    ("transfernow.net", "transfernow", "TransferNow", "TransferNow", CATEGORY_CLOUD),
    ("send.vis.ee", "send_vis", "Send", "Send", CATEGORY_CLOUD),
    ("pastebin.com", "pastebin", "Pastebin", "Pastebin", CATEGORY_CLOUD),
    ("github.com", "github", "GitHub", "GitHub", CATEGORY_CLOUD),
    ("gitlab.com", "gitlab", "GitLab", "GitLab", CATEGORY_CLOUD),
    # ── Collaboration ──
    ("slack.com", "slack", "Slack", "Salesforce", CATEGORY_COLLABORATION),
    ("teams.microsoft.com", "teams", "Microsoft Teams", "Microsoft", CATEGORY_COLLABORATION),
    ("teams.live.com", "teams", "Microsoft Teams", "Microsoft", CATEGORY_COLLABORATION),
    ("discord.com", "discord", "Discord", "Discord", CATEGORY_COLLABORATION),
    ("web.whatsapp.com", "whatsapp_web", "WhatsApp Web", "Meta", CATEGORY_COLLABORATION),
    ("web.telegram.org", "telegram_web", "Telegram Web", "Telegram", CATEGORY_COLLABORATION),
    ("app.zoom.us", "zoom", "Zoom", "Zoom", CATEGORY_COLLABORATION),
    ("meet.google.com", "google_meet", "Google Meet", "Google", CATEGORY_COLLABORATION),
    ("chat.google.com", "google_chat", "Google Chat", "Google", CATEGORY_COLLABORATION),
    ("atlassian.net", "atlassian", "Atlassian (Jira/Confluence)", "Atlassian", CATEGORY_COLLABORATION),
    ("notion.so", "notion", "Notion", "Notion", CATEGORY_COLLABORATION),
    ("trello.com", "trello", "Trello", "Atlassian", CATEGORY_COLLABORATION),
    ("asana.com", "asana", "Asana", "Asana", CATEGORY_COLLABORATION),
    ("linkedin.com", "linkedin", "LinkedIn", "Microsoft", CATEGORY_COLLABORATION),
    ("mattermost.com", "mattermost", "Mattermost", "Mattermost", CATEGORY_COLLABORATION),
    ("rocket.chat", "rocketchat", "Rocket.Chat", "Rocket.Chat", CATEGORY_COLLABORATION),
    # ── Generative AI ──
    ("chatgpt.com", "chatgpt", "ChatGPT", "OpenAI", CATEGORY_GENAI),
    ("chat.openai.com", "chatgpt", "ChatGPT", "OpenAI", CATEGORY_GENAI),
    ("openai.com", "openai", "OpenAI", "OpenAI", CATEGORY_GENAI),
    ("claude.ai", "claude", "Claude", "Anthropic", CATEGORY_GENAI),
    ("anthropic.com", "anthropic", "Anthropic", "Anthropic", CATEGORY_GENAI),
    ("gemini.google.com", "gemini", "Gemini", "Google", CATEGORY_GENAI),
    ("bard.google.com", "gemini", "Gemini", "Google", CATEGORY_GENAI),
    ("aistudio.google.com", "google_ai_studio", "Google AI Studio", "Google", CATEGORY_GENAI),
    ("copilot.microsoft.com", "copilot", "Microsoft Copilot", "Microsoft", CATEGORY_GENAI),
    ("bing.com/chat", "copilot", "Microsoft Copilot", "Microsoft", CATEGORY_GENAI),
    ("github.com/copilot", "github_copilot", "GitHub Copilot", "GitHub", CATEGORY_GENAI),
    ("perplexity.ai", "perplexity", "Perplexity", "Perplexity", CATEGORY_GENAI),
    ("deepseek.com", "deepseek", "DeepSeek", "DeepSeek", CATEGORY_GENAI),
    ("chat.deepseek.com", "deepseek", "DeepSeek", "DeepSeek", CATEGORY_GENAI),
    ("grok.com", "grok", "Grok", "xAI", CATEGORY_GENAI),
    ("x.ai", "grok", "Grok", "xAI", CATEGORY_GENAI),
    ("mistral.ai", "mistral", "Le Chat (Mistral)", "Mistral", CATEGORY_GENAI),
    ("chat.mistral.ai", "mistral", "Le Chat (Mistral)", "Mistral", CATEGORY_GENAI),
    ("poe.com", "poe", "Poe", "Quora", CATEGORY_GENAI),
    ("huggingface.co", "huggingface", "Hugging Face", "Hugging Face", CATEGORY_GENAI),
    ("character.ai", "character_ai", "Character.AI", "Character.AI", CATEGORY_GENAI),
    ("you.com", "you_com", "You.com", "You.com", CATEGORY_GENAI),
    ("phind.com", "phind", "Phind", "Phind", CATEGORY_GENAI),
    ("cohere.com", "cohere", "Cohere", "Cohere", CATEGORY_GENAI),
    ("groq.com", "groq", "Groq", "Groq", CATEGORY_GENAI),
    ("together.ai", "together_ai", "Together AI", "Together", CATEGORY_GENAI),
    ("replicate.com", "replicate", "Replicate", "Replicate", CATEGORY_GENAI),
    ("openrouter.ai", "openrouter", "OpenRouter", "OpenRouter", CATEGORY_GENAI),
    ("notebooklm.google.com", "notebooklm", "NotebookLM", "Google", CATEGORY_GENAI),
    ("chat.qwen.ai", "qwen", "Qwen Chat", "Alibaba", CATEGORY_GENAI),
    ("kimi.moonshot.cn", "kimi", "Kimi", "Moonshot", CATEGORY_GENAI),
    ("meta.ai", "meta_ai", "Meta AI", "Meta", CATEGORY_GENAI),
    ("lmarena.ai", "lmarena", "LMArena", "LMArena", CATEGORY_GENAI),
    ("chatbotui.com", "chatbot_ui", "Chatbot UI", "Chatbot UI", CATEGORY_GENAI),
    # NOTE — self-hosted inference (Ollama, open-webui, LM Studio) is deliberately
    # NOT seeded. It is a real gap, and every way of guessing at it is worse than
    # the gap: a browser match pattern cannot carry a port, so seeding
    # "localhost:11434" injects the guard into EVERY localhost page a developer
    # opens, and seeding ports 3000/8080 classifies ordinary dev servers as AI
    # apps. An operator who runs a local LLM UI adds their actual host, and the
    # catalog being a table is exactly what makes that a one-row job.
]


def host_matches(pattern: str, hostname: str) -> bool:
    """Exact host, or a dot-suffix of it. Never a bare substring.

    A substring test would make "box.com" match "dropbox.common-attacker.net",
    which is how host allowlists usually get bypassed.
    """
    p = _norm(pattern).lstrip(".")
    h = _norm(hostname)
    if not p or not h:
        return False
    # Patterns carrying a path segment ("bing.com/chat") are matched by the
    # caller against host+path; here we only compare the host part.
    p_host = p.split("/", 1)[0]
    if p_host.endswith("."):  # e.g. "roundcube." — a leading-label pattern
        return h.startswith(p_host)
    return h == p_host or h.endswith("." + p_host)
