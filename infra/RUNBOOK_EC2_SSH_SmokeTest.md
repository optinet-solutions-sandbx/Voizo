# Runbook — EC2 SSH Access & FreeSWITCH Smoke Test

**Last updated:** 2026-04-22
**EC2 public IP:** `54.251.96.24` (Elastic IP, Singapore `ap-southeast-1`)
**Key file:** `~/Desktop/voizo/voizo-aws/voizo-poc-key.pem`

Use this runbook to SSH into the FreeSWITCH box, check gateway health, and fire a smoke-test call from Git Bash on Windows.

---

## 1. SSH Into the EC2 Box

Open **Git Bash** and run:

```bash
ssh -i ~/Desktop/voizo/voizo-aws/voizo-poc-key.pem admin@54.251.96.24
```

> If you get `WARNING: UNPROTECTED PRIVATE KEY FILE!`, fix permissions first:
> ```bash
> chmod 400 ~/Desktop/voizo/voizo-aws/voizo-poc-key.pem
> ```
> Then retry the SSH command.

You should land at an `admin@ip-172-31-40-48` prompt. No password needed — key-only auth.

---

## 2. Check FreeSWITCH Is Running

```bash
sudo systemctl status freeswitch
```

Expected: `active (running)`. If it's stopped:

```bash
sudo systemctl start freeswitch
```

---

## 3. Check Gateway Health

```bash
sudo fs_cli -x 'sofia status gateway squaretalk'
```

Expected output:

```
Name    squaretalk
Scheme  N/A
Realm   lb-sbc.squaretalk.com
Username
Password
From    <sip:54.251.96.24@lb-sbc.squaretalk.com>
...
State   NOREG
Status  UP  (Ping: Xms)
```

**`NOREG / Status: UP` is healthy.** SquareTalk uses IP auth — we don't register with username/password. Do not try to "fix" NOREG.

If `Status` shows `DOWN` or `FAIL_WAIT`:
- Check `/etc/freeswitch/vars.xml` — confirm `squaretalk_host=lb-sbc.squaretalk.com` and port is `5060`
- Restart the Sofia profile: `sudo fs_cli -x 'sofia profile external restart'`
- Tail logs: `sudo tail -f /var/log/freeswitch/freeswitch.log`

---

## 4. Fire a Smoke-Test Call

This is the standard end-to-end test: FreeSWITCH → SquareTalk → PSTN → Vapi AI bridge.

**Replace `<E164_DESTINATION>` with the target phone number** (e.g., `+35054020611` for Maria's Gibraltar number).

```bash
sudo fs_cli -x "originate {origination_caller_id_number=+442036953434,ignore_early_media=true}sofia/gateway/squaretalk/<E164_DESTINATION> &bridge([sip_auth_username=voizo-poc,sip_auth_password=test123]sofia/external/sip:voizo-poc@sip.vapi.ai)"
```

> **Always include `ignore_early_media=true`.** Without it, FreeSWITCH bridges on the `183 Session Progress` ringing tone, Vapi starts speaking to silence, and hangs up within ~3 seconds. The call will look like a carrier 480 but it's actually a bridge-timing bug.

Expected log output (healthy call):
```
+OK <uuid>
...
Callstate Change EARLY -> ACTIVE    ← customer answered
Correct audio ip/port confirmed     ← RTP flowing on customer leg
Correct audio ip/port confirmed     ← RTP flowing on Vapi leg
```

---

## 5. Capture Mid-Call RTP Stats (Media-Flow Diagnosis)

If the call connects but there's no audio in either direction, use a second Git Bash / SSH window to capture RTP counters **while the call is still alive** (you have ~4 seconds):

**Window 1** — fire the call (as above).

**Window 2** — open a second SSH session immediately after Window 1:

```bash
ssh -i ~/Desktop/voizo/voizo-aws/voizo-poc-key.pem admin@54.251.96.24
```

Then the moment the call fires:

```bash
# Step 1 — get the call UUID
sudo fs_cli -x 'show channels'

# Step 2 — dump RTP stats (replace <UUID> with the UUID from step 1)
sudo fs_cli -x 'uuid_dump <UUID>' | grep -iE "rtp_audio|bytes|packet"
```

Interpret results:

| Counters | Meaning | Action |
|---|---|---|
| Nonzero in **both** directions | FS is forwarding RTP correctly | Problem is carrier/SBC side (SquareTalk or Jambonz) |
| **One direction is zero** | FS bridge is not forwarding that leg | Problem is in FS config |
| Both zero | RTP never arrived | Check SDP / NAT config |

---

## 6. Tail Logs for a Specific Call

```bash
# Replace <UUID> with the call UUID from 'show channels' or the originate output
sudo grep "<UUID>" /var/log/freeswitch/freeswitch.log | tail -80
```

Or follow live:

```bash
sudo tail -f /var/log/freeswitch/freeswitch.log
```

---

## 7. Common SIP Response Meanings

| Response | What it means | Action |
|---|---|---|
| `200 OK` + `ACTIVE` | Call connected, bridge up | Check for audio |
| `183 Session Progress` | Phone is ringing (early media) | Normal — wait for `ACTIVE` |
| `486 Busy Here` | Destination phone was busy | Retry when available |
| `480 Temporarily Unavailable` | Carrier spam filter or bridge-timing bug | Confirm `ignore_early_media=true` is set; if still 480, A-number needed |
| `MANDATORY_IE_MISSING` on Vapi leg | Missing Vapi SIP auth on bridge leg | Add `sip_auth_username=voizo-poc,sip_auth_password=test123` channel vars |

---

## 8. Reload Config After Changes

The FreeSWITCH systemd unit **does not define `ExecReload`** — `systemctl reload freeswitch` will not work. Use `fs_cli` to reload specific modules instead (no call disruption).

If you edit `/etc/freeswitch/autoload_configs/sofia.conf.xml` or `/etc/freeswitch/vars.xml`:

```bash
# Reload Sofia profile only (faster, no calls dropped)
sudo fs_cli -x 'sofia profile external restart'

# Full FreeSWITCH restart (only if Sofia reload doesn't take)
sudo systemctl restart freeswitch
```

If you edit `/etc/freeswitch/autoload_configs/logfile.conf.xml` (or any other module's config):

```bash
sudo fs_cli -x 'reload mod_logfile'
```

Expected output:
```
+OK Reloading XML
+OK module unloaded
+OK module loaded
```

Validate XML before doing a full restart to avoid a broken FS start:

```bash
sudo freeswitch -nc -t
```

---

## 9. Troubleshooting: Sofia Shows 0 Profiles Loaded

**Symptom:**
```
sudo fs_cli -x 'sofia status'
→ 0 profiles 0 aliases

sudo fs_cli -x 'sofia status gateway external::squaretalk'
→ Invalid Gateway!
```

**Root cause (verified 2026-04-22):** The Sofia SQLite database files in `/var/lib/freeswitch/db/` got corrupted after the disk filled to 100%. FS logs the real reason but it's buried in DEBUG-level entries:

```
[CRIT] switch_core_sqldb.c:645 Failure to connect to CORE_DB sofia_reg_external!
[CRIT] sofia.c:3165 Cannot Open SQL Database [external]!
```

The disk fills up primarily from FreeSWITCH's own rotated logs (see §10). When a SQLite write is interrupted mid-transaction by a full disk, the db file is left corrupted. Even after freeing disk space, FS can't open the corrupted file, so Sofia silently fails to start and you get 0 profiles.

**Diagnosis:**

```bash
# 1. Confirm mod_sofia is loaded (it will be — this isn't the issue)
sudo fs_cli -x 'module_exists mod_sofia'

# 2. Check disk space
df -h /

# 3. Check FS logs for the CRIT markers
sudo grep -iE "crit|cannot open sql" /var/log/freeswitch/freeswitch.log | tail -10
```

**Recovery procedure:**

```bash
# 1. Free disk space if needed. Rotated FS logs are the usual culprit:
sudo ls -lh /var/log/freeswitch/
sudo rm /var/log/freeswitch/freeswitch.log.1 /var/log/freeswitch/freeswitch.log.2   # etc — keep freeswitch.log (current)

# 2. Stop FS so nothing writes to the db
sudo systemctl stop freeswitch

# 3. Move the corrupt SQLite files aside (don't delete — keep as backup)
sudo mkdir -p /var/lib/freeswitch/db.bak
sudo bash -c 'mv /var/lib/freeswitch/db/*.db /var/lib/freeswitch/db.bak/'

# 4. Start FS — it will recreate fresh db files on startup
sudo systemctl start freeswitch
sleep 3

# 5. Verify Sofia is back up
sudo fs_cli -x 'sofia status'
# Expected: external profile RUNNING, squaretalk gateway NOREG

sudo fs_cli -x 'sofia status gateway external::squaretalk'
# Expected: State: NOREG, Status: UP, PingState: 1/1/1
```

**Why the `bash -c` wrapping?** The `admin` user can't read `/var/lib/freeswitch/db/` (permissions are `770 freeswitch:freeswitch`), so a bare `sudo mv /var/lib/.../db/*.db ...` fails — the shell expands the glob *before* sudo runs. `sudo bash -c '...'` runs the glob expansion inside the sudo'd shell where it has permission.

**Why these db files are safe to discard:**
- They hold SIP registration state — and we use IP auth, not REGISTER, so there's no registration state to lose
- Call history (CDRs) lives separately in `/var/log/freeswitch/cdr-csv/`, untouched
- FS recreates these files on startup if missing

**Post-recovery:** ensure the preventive config in §10 is in place so the disk can't fill from rotated logs again.

---

## 10. Log Rotation Config (Preventive)

FreeSWITCH handles its own log rotation via `/etc/freeswitch/autoload_configs/logfile.conf.xml` (there is **no** `/etc/logrotate.d/freeswitch` config — system logrotate does not touch FS logs).

**Required values for this 8GB EC2 disk** (set 2026-04-22 after the disk-fill incident):

```xml
<param name="rollover" value="524288000"/>    <!-- 500 MB per file -->
<param name="maximum-rotate" value="3"/>      <!-- keep at most 3 rotated files -->
```

| Param | Default | Ours | Meaning |
|---|---|---|---|
| `rollover` | `1048576000` (1 GB) | `524288000` (500 MB) | Size threshold at which FS closes the current log and starts a new one |
| `maximum-rotate` | `32` | `3` | Max rotated files FS keeps before deleting the oldest on next rotation |

**Math:** 3 rotated files × 500 MB + 1 live log = **~2 GB** worst-case log footprint, well under the 7.7 GB disk.

**The default `32 × 1 GB = 32 GB` is a disk-fill incident waiting to happen** on this box. Never revert to defaults without also expanding the disk.

**To apply changes to this config without restarting FS:**

```bash
sudo fs_cli -x 'reload mod_logfile'
```

Expected output:
```
+OK Reloading XML
+OK module unloaded
+OK module loaded
```

This reloads only the logfile module — Sofia, active calls, and gateway registration are untouched.

**Verify current values:**

```bash
sudo grep -E "rollover|maximum-rotate" /etc/freeswitch/autoload_configs/logfile.conf.xml
```

---

## 11. Key References

| Item | Value |
|---|---|
| EC2 public IP | `54.251.96.24` |
| EC2 instance ID | `i-026925f03972e7628` |
| EC2 region | `ap-southeast-1` (Singapore) |
| SSH key path | `~/Desktop/voizo/voizo-aws/voizo-poc-key.pem` |
| SSH user | `admin` |
| SquareTalk gateway host | `lb-sbc.squaretalk.com:5060` |
| Caller ID (SquareTalk test CID) | `+442036953434` |
| Vapi SIP endpoint | `sip:voizo-poc@sip.vapi.ai` |
| Vapi SIP username | `voizo-poc` |
| Vapi SIP password | `test123` |
| Maria's test number | `+35054020611` (Gibraltar) |
| FS log path | `/var/log/freeswitch/freeswitch.log` |
| FS config dir | `/etc/freeswitch/` |
