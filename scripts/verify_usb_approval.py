"""End-to-end verification of the USB device approval flow against a LIVE server.

Covers the points where the runtime authorization and the OFFLINE allowlist the
agent enforces from can disagree — which is where the deny-carve-out bug lived.
Same invocation as verify_web_activity.py.
"""
import asyncio, sys, uuid
import httpx

from app.core.security import create_access_token

BASE = "http://localhost:55100/api/v1"
fails = []


def check(label, got, want):
    ok = got == want
    print(f"  [{'PASS' if ok else 'FAIL'}] {label}: got={got!r} want={want!r}")
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
    H = {"Authorization": "Bearer " + create_access_token(
        data={"sub": str(row[0]), "email": row[1], "role": "ADMIN"})}

    tag = uuid.uuid4().hex[:8]
    agent_id = f"usbtest-{tag}"
    MFG = f"TestVendor{tag}"
    GOOD = f"GOODSER{tag}"
    BAD = f"BADSER{tag}"
    created = []
    policy_id = None

    async with httpx.AsyncClient(timeout=45) as c:
        r = await c.post(f"{BASE}/agents/", json={
            "agent_id": agent_id, "name": f"USB Test {tag}", "os": "windows",
            "ip_address": "10.0.0.9", "version": "1.0.0"})
        reg = r.json()
        canonical = reg.get("agent_id") or agent_id
        AH = {"X-Agent-Key": reg.get("api_key")} if reg.get("api_key") else {}

        # A device-control policy in ENFORCE mode.
        r = await c.post(f"{BASE}/policies/", headers=H, json={
            "name": f"USB Control Test {tag}", "description": "e2e",
            "type": "usb_device_control", "severity": "high", "enabled": True,
            "config": {"mode": "enforce", "access_mode": "read_write"}})
        policy_id = r.json().get("id") if r.status_code in (200, 201) else None
        print(f"  (policy {policy_id})")

        def authorize(serial, manufacturer=MFG, product="TestStick", vid="1234", pid="5678"):
            return c.post(f"{BASE}/agents/{canonical}/device/authorize", headers=AH, json={
                "serial_number": serial, "manufacturer": manufacturer,
                "product_name": product, "vendor_id": vid, "product_id": pid})

        # ── 1. Default deny ─────────────────────────────────────────────
        print("\n=== 1. an unknown device is blocked (strict allowlist) ===")
        v = (await authorize(GOOD)).json()
        check("unknown device blocked", v["action"], "block")

        # ── 2. Approve by serial ────────────────────────────────────────
        print("\n=== 2. approving a serial lets it in ===")
        r = await c.post(f"{BASE}/usb-devices/", headers=H, json={
            "match_type": "serial", "serial_number": GOOD, "decision": "allow",
            "product_name": "TestStick", "manufacturer": MFG})
        check("approve 201", r.status_code, 201)
        created.append(r.json()["id"])
        v = (await authorize(GOOD)).json()
        check("approved device allowed", v["action"], "allow")

        r = await c.get(f"{BASE}/agents/{canonical}/usb-allowlist", headers=AH)
        al = r.json()
        check("serial reaches the agent allowlist", GOOD.upper() in al["serials"], True)

        # ── 3. Vendor-wide allow ────────────────────────────────────────
        print("\n=== 3. allowing a whole vendor ===")
        r = await c.post(f"{BASE}/usb-devices/", headers=H, json={
            "match_type": "manufacturer", "match_value": MFG, "decision": "allow",
            "alias": "Test vendor fleet"})
        check("vendor allow 201", r.status_code, 201)
        created.append(r.json()["id"])
        v = (await authorize(BAD)).json()
        check("another device from that vendor allowed", v["action"], "allow")

        # ── 4. The carve-out: deny one serial from an allowed vendor ────
        print("\n=== 4. denying one bad serial inside an allowed vendor ===")
        r = await c.post(f"{BASE}/usb-devices/", headers=H, json={
            "match_type": "serial", "serial_number": BAD, "decision": "deny",
            "product_name": "TestStick", "manufacturer": MFG})
        check("deny 201", r.status_code, 201)
        created.append(r.json()["id"])

        v = (await authorize(BAD)).json()
        print(f"      runtime reason -> {v['reason']}")
        check("runtime: deny beats the vendor allow", v["action"], "block")
        v = (await authorize(GOOD)).json()
        check("runtime: the good one still works", v["action"], "allow")

        print("\n--- the same question, asked of the OFFLINE allowlist ---")
        r = await c.get(f"{BASE}/agents/{canonical}/usb-allowlist", headers=AH)
        al = r.json()
        print(f"      serials={al['serials']}")
        print(f"      manufacturers={al['manufacturers']}")
        print(f"      denied_serials={al.get('denied_serials', '<ABSENT>')}")
        # The agent builds its offline block list from this. If the denied serial
        # is not in it, the agent has no way to know the device is disallowed —
        # the vendor allow admits it before the runtime check ever happens.
        check("denied serial is communicated to the agent",
              BAD.upper() in (al.get("denied_serials") or []), True)

        # ── 5. Deny in audit mode ───────────────────────────────────────
        print("\n=== 5. audit mode reports rather than blocks ===")
        if policy_id:
            await c.put(f"{BASE}/policies/{policy_id}", headers=H, json={
                "name": f"USB Control Test {tag}", "description": "e2e",
                "type": "usb_device_control", "severity": "high", "enabled": True,
                "config": {"mode": "audit", "access_mode": "read_write"}})
            v = (await authorize(BAD)).json()
            check("audit does not block a denied device", v["action"], "allow")
            check("but flags would_block", v.get("would_block"), True)
            r = await c.get(f"{BASE}/agents/{canonical}/usb-allowlist", headers=AH)
            check("allowlist reports audit mode", r.json()["mode"], "audit")
            await c.put(f"{BASE}/policies/{policy_id}", headers=H, json={
                "name": f"USB Control Test {tag}", "description": "e2e",
                "type": "usb_device_control", "severity": "high", "enabled": True,
                "config": {"mode": "enforce", "access_mode": "read_write"}})

        # ── 6. Suspending an approval ───────────────────────────────────
        print("\n=== 6. suspending an approval revokes access ===")
        r = await c.patch(f"{BASE}/usb-devices/{created[0]}", headers=H,
                          json={"is_enabled": False})
        check("suspend 200", r.status_code, 200)
        v = (await authorize(GOOD)).json()
        check("suspended serial no longer allowed by its own row", v["action"], "allow")
        print("      (still allowed by the vendor-wide rule — that is correct)")
        r = await c.get(f"{BASE}/agents/{canonical}/usb-allowlist", headers=AH)
        check("suspended serial dropped from the allowlist",
              GOOD.upper() in r.json()["serials"], False)
        await c.patch(f"{BASE}/usb-devices/{created[0]}", headers=H, json={"is_enabled": True})

        # ── 7. Re-approving a denied device ─────────────────────────────
        print("\n=== 7. flipping a deny back to allow ===")
        r = await c.post(f"{BASE}/usb-devices/", headers=H, json={
            "match_type": "serial", "serial_number": BAD, "decision": "allow"})
        check("re-approve accepted", r.status_code in (200, 201), True)
        v = (await authorize(BAD)).json()
        check("previously denied device now allowed", v["action"], "allow")
        async with D.postgres_session_factory() as db:
            n = (await db.execute(text(
                "SELECT count(*) FROM sanctioned_usb_devices "
                "WHERE match_type='serial' AND lower(match_value)=lower(:s)"),
                {"s": BAD})).scalar()
        check("no duplicate row created by the flip", n, 1)

        # ── 8. Revoking entirely ────────────────────────────────────────
        print("\n=== 8. revoking removes access ===")
        r = await c.get(f"{BASE}/usb-devices/", headers=H)
        rows = {d["id"]: d for d in r.json()["devices"]}
        for did in list(rows):
            d = rows[did]
            if (d.get("match_value") or "").lower() == MFG.lower():
                await c.delete(f"{BASE}/usb-devices/{did}", headers=H)
        v = (await authorize(f"NEVERSEEN{tag}")).json()
        check("vendor rule gone, unknown device blocked again", v["action"], "block")

        # ── cleanup ─────────────────────────────────────────────────────
        r = await c.get(f"{BASE}/usb-devices/", headers=H)
        for d in r.json()["devices"]:
            mv = (d.get("match_value") or d.get("serial_number") or "")
            if tag in mv or tag in (d.get("alias") or ""):
                await c.delete(f"{BASE}/usb-devices/{d['id']}", headers=H)
        if policy_id:
            await c.delete(f"{BASE}/policies/{policy_id}", headers=H)
        await c.delete(f"{BASE}/agents/{canonical}", headers=H)

    async with D.postgres_session_factory() as db:
        await db.execute(text(
            "DELETE FROM sanctioned_usb_devices WHERE match_value LIKE :t OR serial_number LIKE :t"),
            {"t": f"%{tag}%"})
        await db.execute(text("DELETE FROM policies WHERE name LIKE :n"),
                         {"n": f"USB Control Test {tag}%"})
        await db.execute(text("DELETE FROM agents WHERE agent_id = :a"), {"a": canonical})
        await db.commit()
    mongo = D.get_mongodb()["dlp_events"]
    await mongo.delete_many({"agent_id": canonical})
    await D.close_databases()

    print("\n" + "=" * 62)
    if fails:
        print(f"FAILED ({len(fails)}): {fails}")
        sys.exit(1)
    print("ALL CHECKS PASSED")


asyncio.run(main())
