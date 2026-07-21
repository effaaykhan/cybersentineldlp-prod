"""
CyberSentinel DLP — SMTP relay entrypoint.

Listens for outbound mail (routed here by Google Workspace's outbound gateway
or your MTA's smarthost), inspects every attachment + body, and rejects any
message carrying Confidential/Restricted content before it can leave.
"""
import asyncio
import logging
import signal

from aiosmtpd.controller import Controller

from .config import config
from .handler import DLPHandler

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("csdlp.relay")


def main() -> None:
    # Refuse to run without agent credentials.
    #
    # Without a key every evaluate() call fails, and with the default
    # RELAY_BLOCK_ON_DLP_ERROR=false that failure resolves to "allow" — so the
    # relay would sit in the mail path forwarding EVERY message untouched while
    # looking like it enforces email DLP. A control that silently passes what it
    # never inspected is worse than no control, because it is trusted. Fail here,
    # loudly, instead of at the first sensitive attachment.
    if not config.DLP_AGENT_KEY:
        log.error("=" * 62)
        log.error("  REFUSING TO START: no DLP agent key configured.")
        log.error("  Without RELAY_AGENT_KEY this relay cannot authenticate to")
        log.error("  the DLP server, so it would forward every message WITHOUT")
        log.error("  inspecting it while appearing to enforce email DLP.")
        log.error("")
        log.error("  Fix: register an agent on the manager, then set in .env:")
        log.error("    RELAY_AGENT_ID=<agent_id>")
        log.error("    RELAY_AGENT_KEY=<that agent's api_key>")
        log.error("=" * 62)
        raise SystemExit(1)

    controller = Controller(
        DLPHandler(),
        hostname=config.LISTEN_HOST,
        port=config.LISTEN_PORT,
        data_size_limit=config.MAX_MESSAGE_BYTES,
        enable_SMTPUTF8=True,
    )
    controller.start()
    log.info("DLP SMTP relay listening on %s:%s", config.LISTEN_HOST, config.LISTEN_PORT)
    log.info("DLP server: %s (agent=%s, keyed=%s)",
             config.DLP_SERVER_URL, config.DLP_AGENT_ID, bool(config.DLP_AGENT_KEY))
    if config.NEXT_HOP_HOST:
        log.info("next hop: %s:%s (starttls=%s)",
                 config.NEXT_HOP_HOST, config.NEXT_HOP_PORT, config.NEXT_HOP_STARTTLS)
    else:
        log.warning("NO NEXT HOP configured — clean mail is accepted but NOT delivered (test mode)")

    loop = asyncio.new_event_loop()
    stop = loop.create_future()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, lambda: stop.done() or stop.set_result(None))
        except NotImplementedError:
            pass
    try:
        loop.run_until_complete(stop)
    finally:
        controller.stop()
        log.info("relay stopped")


if __name__ == "__main__":
    main()
