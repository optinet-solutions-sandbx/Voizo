# Voizo FreeSWITCH Webhook Shim

Small Node service that runs **on the AWS EC2 box alongside FreeSWITCH**. It subscribes to FreeSWITCH's ESL event stream and translates relevant events into HTTP POSTs to the Voizo dashboard, signed with HMAC-SHA256.

**Why:** FreeSWITCH emits events over its Event Socket Layer (ESL, a custom TCP protocol on port 8021). It doesn't do HTTP webhooks natively. This shim is the translator.

---

## What's In Here

| File | Purpose |
|---|---|
| `index.js` | The shim itself (~150 lines, no framework) |
| `package.json` | Declares `modesl` as the only runtime dep |
| `voizo-shim.service` | systemd unit for running as a service on the EC2 box |
| `README.md` | This file |

---

## Events Relayed

Right now, one event:

- **`CHANNEL_HANGUP_COMPLETE`** — emitted when a call ends. Contains final status, duration, hangup cause, and all channel variables (including our `voizo_call_id`, `voizo_campaign_id`, `voizo_number_id`).

The shim only forwards events that have `voizo_call_id` set — so ad-hoc test calls and other channel activity on the FS box don't spam the dashboard.

Future events (as needed):
- `CHANNEL_ANSWER` — if we want real-time "customer picked up" events
- `CUSTOM::sofia::register` — if we want registration-health monitoring

---

## Environment Variables

| Var | Required | Default | Notes |
|---|---|---|---|
| `ESL_HOST` | | `127.0.0.1` | FS listens locally; leave as default |
| `ESL_PORT` | | `8021` | FS default |
| `ESL_PASSWORD` | ✅ | — | From `vars.xml` on the FS box |
| `VOIZO_WEBHOOK_URL` | ✅ | — | Full URL to `/api/webhooks/freeswitch/voice-status` on the Voizo dashboard (e.g. `https://voizo-eight.vercel.app/api/webhooks/freeswitch/voice-status`) |
| `VOIZO_WEBHOOK_SECRET` | ✅ | — | Must match `FREESWITCH_WEBHOOK_SECRET` in the Voizo `.env.local` |
| `DRY_RUN` | | `false` | If `true`, logs the POST instead of sending. Useful for first-boot testing. |

---

## Deployment (AWS EC2 box, after Phase 1 provisioning)

From your laptop:

```bash
# Copy shim files to the box
EIP=<your-elastic-ip>
KEY=~/voizo-aws/voizo-poc-key.pem
scp -i $KEY -r infra/freeswitch/webhook-shim ubuntu@$EIP:/tmp/voizo-shim
```

On the EC2 box (SSHed in):

```bash
# Install Node 18+ if not already present (Ubuntu 22.04 has node 12 by default — too old)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Move shim to its home and install deps
sudo mv /tmp/voizo-shim /opt/voizo-shim
cd /opt/voizo-shim
sudo npm install --production

# Install the systemd unit
sudo cp voizo-shim.service /etc/systemd/system/

# Edit the env vars in the unit file
sudo nano /etc/systemd/system/voizo-shim.service
# Fill in ESL_PASSWORD, VOIZO_WEBHOOK_URL, VOIZO_WEBHOOK_SECRET

sudo systemctl daemon-reload
sudo systemctl enable --now voizo-shim

# Watch it start up
sudo journalctl -u voizo-shim -f
# Expect to see: "[shim] connecting to FreeSWITCH ESL at 127.0.0.1:8021"
# Then: "[shim] ESL connected. Subscribing to CHANNEL_HANGUP_COMPLETE"
```

---

## Testing Locally (No AWS)

Before deploying, you can run it against a local FreeSWITCH (or in DRY_RUN without any FS):

```bash
cd infra/freeswitch/webhook-shim
npm install

# Dry-run mode: logs what it *would* send, without actually POSTing
DRY_RUN=true ESL_PASSWORD=test VOIZO_WEBHOOK_URL=http://localhost:3001/... VOIZO_WEBHOOK_SECRET=test npm start
```

---

## What The Shim Does NOT Do

- Does not retry indefinitely — max 3 attempts with exponential backoff, then drops the event. The Voizo dashboard must tolerate missed events (idempotent design on the dashboard side handles this).
- Does not persist state — runs statelessly. If the shim crashes, any in-flight events are lost. The dashboard recovers from DB state, so this is acceptable for the PoC. Production: add a small queue (e.g. local Redis or sqlite).
- Does not validate the ESL connection TLS — ESL is plain TCP. Since shim and FS run on the same box (127.0.0.1), this is fine. If you ever move ESL to a different host, use an SSH tunnel.
- Does not handle FS restarts — if FreeSWITCH goes down, modesl's built-in reconnect logic kicks in. If that fails, systemd restarts the shim (`Restart=on-failure`).
