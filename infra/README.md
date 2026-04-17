# Voizo Infrastructure — FreeSWITCH PoC

**Status:** Phase 0 (2026-04-15) — scaffolding in place, awaiting Chris's unblockers (AWS access, SquareTalk creds, Vapi allow-list, test number, caller ID) to deploy.

**Authoritative spec:** `../docs/2026-04-15_SPEC_FreeSWITCH_Pitch_MVP.md`

---

## What's In Here

```
infra/
├── README.md                          # this file
├── aws/
│   └── freeswitch-poc.sh              # one-shot AWS provisioning script (EC2 + EIP + SG)
└── freeswitch/
    ├── sofia.conf.xml                 # Sofia SIP profile — registers to SquareTalk
    ├── dialplan/
    │   └── voizo.xml                  # bridges answered customer leg to Vapi
    └── vars.xml.example               # global vars template (fill in real creds)
```

## Deployment Flow (Once Unblockers Land)

### Phase 1 — Provision AWS infra
1. Get AWS account creds + region confirmation from Chris
2. Edit `aws/freeswitch-poc.sh`: set `MY_KEY_NAME` to your EC2 SSH key
3. Verify `AMI_ID` is current (Ubuntu 22.04 LTS in your region) — use:
   ```bash
   aws ec2 describe-images --owners 099720109477 \
     --filters "Name=name,Values=ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*" \
     --query "Images | sort_by(@, &CreationDate) | [-1].ImageId" --region ap-southeast-1
   ```
4. Run: `chmod +x aws/freeswitch-poc.sh && ./aws/freeswitch-poc.sh`
5. Save the Elastic IP from the output — needed for steps 2, 3, and 5

### Phase 2 — Deploy FreeSWITCH config + register to SquareTalk
1. Get SquareTalk username + password from Maria (via Chris)
2. Wait ~3 min for the EC2 user-data bootstrap to finish (`sudo cat /var/log/voizo-bootstrap.log`)
3. Copy configs to the box:
   ```bash
   EIP=<elastic-ip-from-step-1>
   KEY=~/.ssh/<your-key>.pem
   scp -i $KEY freeswitch/sofia.conf.xml      ubuntu@$EIP:/tmp/
   scp -i $KEY freeswitch/dialplan/voizo.xml  ubuntu@$EIP:/tmp/
   scp -i $KEY freeswitch/vars.xml.example    ubuntu@$EIP:/tmp/vars.xml
   ```
4. SSH in, edit `/tmp/vars.xml` and fill in:
   - `squaretalk_username` + `squaretalk_password`
   - `external_ip` = the Elastic IP
   - `esl_password` = strong random string (save for step 5)
5. Move files into place + restart:
   ```bash
   sudo mv /tmp/sofia.conf.xml /etc/freeswitch/autoload_configs/sofia.conf.xml
   sudo mv /tmp/voizo.xml /etc/freeswitch/dialplan/default/voizo.xml
   sudo mv /tmp/vars.xml /etc/freeswitch/vars.xml
   sudo systemctl restart freeswitch
   ```
6. Verify registration to SquareTalk:
   ```bash
   sudo fs_cli -x 'sofia status gateway external::squaretalk'
   # expect: State: REGED  (registered)
   ```

### Phase 3 — Wire Vapi allow-list
1. Send the Elastic IP to Ernie/Maria
2. Confirm in writing that the IP is added to Vapi's allow-list
3. Test outbound to Vapi only (no customer call yet):
   ```bash
   sudo fs_cli -x 'originate sofia/external/sip:<test-assistant>@sip.vapi.ai &echo'
   # expect: connection established without auth-rejected error
   ```

### Phase 4 — Wire Voizo dashboard
1. In `Voizo/.env.local`, set:
   ```
   FREESWITCH_HOST=<elastic-ip>
   FREESWITCH_ESL_PORT=8021
   FREESWITCH_ESL_PASSWORD=<value-from-vars.xml>
   FREESWITCH_WEBHOOK_SECRET=<random-hex>
   SQUARETALK_HOST=lb-sbc.squaretalk.com
   SQUARETALK_PORT=5080
   SQUARETALK_USERNAME=<from-maria>
   SQUARETALK_PASSWORD=<from-maria>
   SQUARETALK_CALLER_ID=<from-chris>
   FREESWITCH_STUB=false  # switch off the stub
   ```
2. Install ESL client: `npm install modesl`
3. Implement the live ESL connection in `src/lib/freeswitch/client.ts` (replace stub TODO)
4. Build the webhook shim on the AWS box (small Node script that subscribes to FS
   `CHANNEL_HANGUP_COMPLETE` events and POSTs them to
   `<voizo-vercel-url>/api/webhooks/freeswitch/voice-status` with HMAC signature)

### Phase 5 — Demo + Pitch
- Place a test call from a tiny CLI/curl trigger
- Record 90-sec demo video
- One-page PDF (cost case + flow + ops snapshot)
- Send to Chris

---

## Tear Down (When PoC Is Done)

If Chris approves the migration → keep the box running, harden it, hand off ops.

If Chris rejects → tear down to stop AWS billing:

```bash
EIP_ALLOC=<allocation-id-from-script-output>
INSTANCE_ID=<instance-id-from-script-output>
SG_ID=<sg-id-from-script-output>
REGION=ap-southeast-1

aws ec2 terminate-instances  --region $REGION --instance-ids $INSTANCE_ID
aws ec2 wait instance-terminated --region $REGION --instance-ids $INSTANCE_ID
aws ec2 release-address      --region $REGION --allocation-id $EIP_ALLOC
aws ec2 delete-security-group --region $REGION --group-id $SG_ID
```

---

## Manifesto Override (On Record)

Self-hosted FreeSWITCH on AWS overrides §1 ("Beautifully Boring") of `../docs/CODEBASE_MANIFESTO.md`. This was a conscious cost-driven decision per Chris (2026-04-15). Future readers should not interpret this as license to add other self-hosted infra casually — the bar is specifically "recurring savings exceed recurring ops cost by a wide margin."

---

## Common Operational Gotchas (Anticipated)

| Symptom | Likely cause | Where to look |
|---|---|---|
| Customer hears nothing after answering | Vapi allow-list missing our Elastic IP | Send EIP to Ernie/Maria; verify with `sudo tcpdump -i any port 5060 host sip.vapi.ai` |
| `sofia status gateway` shows FAIL_WAIT | Wrong SquareTalk credentials | Check `vars.xml`, restart FS, watch `/var/log/freeswitch/freeswitch.log` |
| Calls connect but audio is one-way | RTP NAT misconfiguration | Verify `ext-rtp-ip` matches Elastic IP; security group allows UDP 16384–32768 |
| FS won't start after config change | XML syntax error | `sudo freeswitch -nc -t` to validate config without launching |
| Random call drops | Network/RTP timeout | Check `rtp-timeout-sec` in sofia.conf.xml; verify EC2 has stable network |
| `unauthorized` from SquareTalk | Registration expired | `sudo fs_cli -x 'sofia profile external killgw squaretalk'` then `'sofia profile external rescan'` |
