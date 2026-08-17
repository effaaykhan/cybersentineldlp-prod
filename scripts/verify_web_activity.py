"""End-to-end verification of granular web activity control against a LIVE server.

Not a unit test — it needs a running manager, Postgres and Mongo, which is why it
lives here rather than under server/tests (pytest would collect it and fail).
Run it after deploying to a new environment to prove the whole chain works:
catalog sync -> policy matrix -> evaluate verdict -> event ingest.

    docker cp scripts/verify_web_activity.py <manager>:/app/
    docker compose exec -T -w /app -e PYTHONPATH=/app manager python verify_web_activity.py

Creates and cleans up its own agent, policy and events.
"""
import asyncio, sys, uuid, json
import httpx

from app.core.security import create_access_token

BASE = "http://localhost:55100/api/v1"
fails = []


def check(label, got, want):
    ok = got == want
    print(f"  [{'PASS' if ok else 'FAIL'}] {label}: got={got!r} want={want!r}")
    if not ok:
        fails.append(label)


def check_true(label, got):
    ok = bool(got)
    print(f"  [{'PASS' if ok else 'FAIL'}] {label}: {got!r}")
    if not ok:
        fails.append(label)


async def main():
    from app.core import database as D
    from sqlalchemy import text
    await D.init_databases()

    async with D.postgres_session_factory() as db:
        row = (await db.execute(text(
            "SELECT id,email FROM users WHERE role='ADMIN' AND is_active "
            "ORDER BY created_at LIMIT 1"))).first()
    admin_id = str(row[0])
    H = {"Authorization": "Bearer " + create_access_token(
        data={"sub": admin_id, "email": row[1], "role": "ADMIN"})}

    tag = uuid.uuid4().hex[:8]
    agent_id = f"test-browser-{tag}"
    policy_id = None

    async with httpx.AsyncClient(timeout=60) as c:
        # ── 1. Catalog ──────────────────────────────────────────────────
        print("\n=== 1. app catalog classifies destinations ===")
        r = await c.get(f"{BASE}/app-catalog/", headers=H)
        check("catalog list 200", r.status_code, 200)
        body = r.json()
        check_true("catalog has entries", body["count"] > 50)
        check_true("GenAI category populated", body["by_category"].get("genai", 0) > 20)
        hosts = {e["host_pattern"]: e for e in body["entries"]}
        check("chatgpt.com is genai", hosts.get("chatgpt.com", {}).get("category"), "genai")
        check("claude.ai is genai", hosts.get("claude.ai", {}).get("category"), "genai")
        check("mail.google.com is webmail", hosts.get("mail.google.com", {}).get("category"), "webmail")
        check("dropbox.com is cloud", hosts.get("dropbox.com", {}).get("category"), "cloud_storage")
        check_true("vocabulary exposed for the matrix UI", len(body["activities"]) == 6)

        # ── 2. Agent enrols (as the extension does) ─────────────────────
        print("\n=== 2. the extension enrols and gets a key ===")
        r = await c.post(f"{BASE}/agents/", json={
            "agent_id": agent_id, "name": f"Test Browser {tag}", "os": "linux",
            "ip_address": "browser-extension", "version": "2.0.0",
            "capabilities": {"web_activity_control": True},
        })
        check("registration 2xx", r.status_code in (200, 201), True)
        reg = r.json()
        canonical = reg.get("agent_id") or agent_id
        key = reg.get("api_key")
        check_true("agent key issued", bool(key))
        AH = {"X-Agent-Key": key} if key else {}

        # ── 3. Catalog sync (what the extension pulls) ──────────────────
        print("\n=== 3. endpoint catalog sync + etag ===")
        r = await c.get(f"{BASE}/app-catalog/sync", headers=AH)
        check("sync 200", r.status_code, 200)
        sync = r.json()
        check_true("sync returns entries", sync["count"] > 50)
        etag = sync["etag"]
        r2 = await c.get(f"{BASE}/app-catalog/sync", headers=AH, params={"etag": etag})
        check("unchanged on same etag", r2.json()["unchanged"], True)
        check("unchanged body is empty", len(r2.json()["entries"]), 0)

        # ── 4. No policy => nothing enforced ────────────────────────────
        print("\n=== 4. with no policy, nothing is enforced ===")
        r = await c.get(f"{BASE}/agents/{canonical}/web-activity-policy", headers=AH)
        check("policy endpoint 200", r.status_code, 200)
        check("not enforced without a policy", r.json()["enforced"], False)

        ev = {
            "file_name": "ChatGPT post", "event_type": "genai",
            "activity": "post", "app_category": "genai", "app_id": "chatgpt",
            "app_name": "ChatGPT", "destination_type": "web",
            "text_content": "My Aadhaar number is 1234 5678 9012 please summarise it",
        }
        r = await c.post(f"{BASE}/agents/{canonical}/policy/evaluate", headers=AH, json=ev)
        check("evaluate 200", r.status_code, 200)
        v = r.json()
        print(f"      classification -> {v['classification']['level']}")
        check("sensitive prompt ALLOWED when no policy exists", v["action"], "allow")
        check_true("but it was still classified", v["classification"]["level"] in ("Confidential", "Restricted"))

        # ── 5. Create the matrix policy ─────────────────────────────────
        print("\n=== 5. a policy that blocks GenAI posts of Confidential+ ===")
        r = await c.post(f"{BASE}/policies/", headers=H, json={
            "name": f"WebActivity Test {tag}",
            "description": "e2e test",
            "type": "web_activity_control",
            "severity": "high",
            "status": "active",
            "config": {
                "mode": "enforce",
                "minLevel": "Confidential",
                "matrix": {
                    "genai": {"post": "block", "attach": "block", "download": "log"},
                    "webmail": {"send": "alert"},
                },
                "appOverrides": [{"app_id": "copilot", "action": "allow"}],
                "blockUninspectable": True,
            },
        })
        check("policy created", r.status_code in (200, 201), True)
        if r.status_code in (200, 201):
            policy_id = r.json().get("id")
        else:
            print("      ", r.text[:400])

        # ── 6. The matrix reaches the endpoint ──────────────────────────
        print("\n=== 6. the endpoint receives the matrix ===")
        r = await c.get(f"{BASE}/agents/{canonical}/web-activity-policy", headers=AH)
        pol = r.json()
        check("now enforced", pol["enforced"], True)
        check("mode", pol["mode"], "enforce")
        check("genai/post cell", (pol["matrix"].get("genai") or {}).get("post", {}).get("action"), "block")
        check("webmail/send cell", (pol["matrix"].get("webmail") or {}).get("send", {}).get("action"), "alert")
        check("app override carried", len(pol["app_overrides"]), 1)
        # ai_response is not a webmail activity and must be dropped, not inherited
        check("nonsense pairs excluded", "ai_response" in (pol["matrix"].get("webmail") or {}), False)

        # ── 7. Enforcement ──────────────────────────────────────────────
        print("\n=== 7. the same prompt is now blocked ===")
        r = await c.post(f"{BASE}/agents/{canonical}/policy/evaluate", headers=AH, json=ev)
        v = r.json()
        print(f"      reason -> {v['reason'][:150]}")
        check("sensitive GenAI post BLOCKED", v["action"], "block")
        check_true("reason names the policy", "policy" in v["reason"].lower())

        print("\n=== 8. an ordinary prompt still goes through ===")
        benign = dict(ev, text_content="what is the capital of France?")
        r = await c.post(f"{BASE}/agents/{canonical}/policy/evaluate", headers=AH, json=benign)
        v = r.json()
        print(f"      classification -> {v['classification']['level']}")
        check("benign prompt allowed (below threshold)", v["action"], "allow")

        print("\n=== 9. the paid-for app is excepted ===")
        excepted = dict(ev, app_id="copilot", app_name="Microsoft Copilot")
        r = await c.post(f"{BASE}/agents/{canonical}/policy/evaluate", headers=AH, json=excepted)
        check("Copilot allowed by app override", r.json()["action"], "allow")

        print("\n=== 10. an unruled activity is untouched ===")
        dl = dict(ev, activity="download")
        r = await c.post(f"{BASE}/agents/{canonical}/policy/evaluate", headers=AH, json=dl)
        check("genai/download is only logged", r.json()["action"], "allow")

        print("\n=== 11. webmail send alerts rather than blocks ===")
        mail = dict(ev, activity="send", app_category="webmail", app_id="gmail",
                    app_name="Gmail", event_type="email", file_name="Gmail message")
        r = await c.post(f"{BASE}/agents/{canonical}/policy/evaluate", headers=AH, json=mail)
        v = r.json()
        check("webmail send not blocked", v["action"], "allow")
        check_true("but it alerts", v["alert_severity"] is not None)

        print("\n=== 12. uninspectable content is not clean ===")
        opaque = {
            "file_name": "secret.7z", "event_type": "genai", "activity": "attach",
            "app_category": "genai", "app_id": "chatgpt", "app_name": "ChatGPT",
            "inspection_skipped": "unreadable", "destination_type": "web",
        }
        r = await c.post(f"{BASE}/agents/{canonical}/policy/evaluate", headers=AH, json=opaque)
        v = r.json()
        print(f"      extraction_status -> {v.get('extraction_status')}, reason -> {v['reason'][:120]}")
        check("unreadable attachment to GenAI blocked", v["action"], "block")

        print("\n=== 13. OCR text the server cannot extract is honoured ===")
        import base64
        # A PNG header with no readable text: server extraction yields nothing,
        # so only the caller-supplied text can convict it.
        png = base64.b64encode(bytes.fromhex("89504e470d0a1a0a") + b"\x00" * 64).decode()
        ocr = {
            "file_name": "IMG_20260817.png", "event_type": "genai", "activity": "attach",
            "app_category": "genai", "app_id": "chatgpt", "app_name": "ChatGPT",
            "destination_type": "web",
            "file_content_b64": png,
            "file_content": "GOVERNMENT OF INDIA Aadhaar 1234 5678 9012",
        }
        r = await c.post(f"{BASE}/agents/{canonical}/policy/evaluate", headers=AH, json=ocr)
        v = r.json()
        print(f"      level -> {v['classification']['level']}, status -> {v.get('extraction_status')}")
        check("OCR text classified the image", v["action"], "block")
        check("extraction upgraded to readable", v.get("extraction_status"), "readable")

        # ── 14. Event ingest with the new fields ────────────────────────
        print("\n=== 14. the event carries the activity and the prompt ===")
        eid = "wa-" + uuid.uuid4().hex
        prompt = "Summarise this: My Aadhaar number is 1234 5678 9012"
        r = await c.post(f"{BASE}/events/", headers=AH, json={
            "event_id": eid, "event_type": "genai", "event_subtype": "genai_post",
            "agent_id": canonical, "source_type": "browser_extension",
            "severity": "critical", "action": "blocked", "blocked": True,
            "classification_level": "Restricted",
            "description": "Content submitted to ChatGPT — BLOCKED",
            "activity": "post", "app_category": "genai",
            "app_id": "chatgpt", "app_name": "ChatGPT",
            "page_url": "https://chatgpt.com/c/abc", "page_host": "chatgpt.com",
            "text_content": prompt, "text_truncated": False,
            "attachment_names": ["card.png"],
        })
        check("event accepted", r.status_code in (200, 201), True)

        mongo = D.get_mongodb()["dlp_events"]
        doc = None
        for _ in range(20):
            doc = await mongo.find_one({"event_id": eid}) or await mongo.find_one({"id": eid})
            if doc:
                break
            await asyncio.sleep(0.5)
        check_true("event persisted", doc is not None)
        if doc:
            check("activity stored", doc.get("activity"), "post")
            check("app_category stored", doc.get("app_category"), "genai")
            check("app_name stored", doc.get("app_name"), "ChatGPT")
            check("page_host stored", doc.get("page_host"), "chatgpt.com")
            check("full prompt stored", doc.get("text_content"), prompt)
            check("mirrored into content", doc.get("content"), prompt)
            check_true("web object mirrored", isinstance(doc.get("web"), dict))
            check("attachments stored", doc.get("attachment_names"), ["card.png"])
            check("domain stamped", doc.get("policy_domain"), "data_protection")

        # ── 15. Audit mode never blocks ─────────────────────────────────
        print("\n=== 15. audit mode reports but never blocks ===")
        if policy_id:
            r = await c.put(f"{BASE}/policies/{policy_id}", headers=H, json={
                "name": f"WebActivity Test {tag}",
                "description": "e2e test",
                "type": "web_activity_control",
                "severity": "high",
                "enabled": True,
                "config": {
                    "mode": "audit", "minLevel": "Confidential",
                    "matrix": {"genai": {"post": "block"}},
                    "appOverrides": [], "blockUninspectable": True,
                },
            })
            check("policy switched to audit", r.status_code in (200, 201), True)
            if r.status_code not in (200, 201):
                print("      ", r.text[:400])
            r = await c.post(f"{BASE}/agents/{canonical}/policy/evaluate", headers=AH, json=ev)
            v = r.json()
            check("audit does not block", v["action"], "allow")
            check_true("audit still alerts", v["alert_severity"] is not None)
            r = await c.get(f"{BASE}/agents/{canonical}/web-activity-policy", headers=AH)
            check("endpoint sees audit mode", r.json()["mode"], "audit")

        # ── cleanup ─────────────────────────────────────────────────────
        if policy_id:
            await c.delete(f"{BASE}/policies/{policy_id}", headers=H)
        await c.delete(f"{BASE}/agents/{canonical}", headers=H)
        await mongo.delete_many({"event_id": eid})

    async with D.postgres_session_factory() as db:
        await db.execute(text("DELETE FROM agents WHERE agent_id = :a"), {"a": canonical})
        await db.execute(text("DELETE FROM policies WHERE name LIKE :n"), {"n": f"WebActivity Test {tag}%"})
        await db.commit()
    await D.close_databases()

    print("\n" + "=" * 62)
    if fails:
        print(f"FAILED ({len(fails)}): {fails}")
        sys.exit(1)
    print("ALL CHECKS PASSED")


asyncio.run(main())
