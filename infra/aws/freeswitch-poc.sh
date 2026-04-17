#!/usr/bin/env bash
#
# FreeSWITCH PoC — AWS EC2 bootstrap script.
#
# STATUS: Phase 0 template (2026-04-15). Run from a workstation with AWS CLI
# configured. Provisions the smallest viable single-instance FreeSWITCH PoC for
# the SquareTalk + Vapi pitch.
#
# Spec: docs/2026-04-15_SPEC_FreeSWITCH_Pitch_MVP.md §5–6
#
# Prerequisites:
#   - aws CLI v2 installed and authenticated (`aws sts get-caller-identity` works)
#   - Default region set OR pass --region ap-southeast-1
#   - An existing SSH key pair in EC2 (set MY_KEY_NAME below)
#   - Your home/office IP for SSH access (auto-detected via curl below)
#
# Usage:
#   chmod +x freeswitch-poc.sh
#   ./freeswitch-poc.sh
#
# Tear down:
#   aws ec2 terminate-instances --instance-ids <id>
#   aws ec2 release-address --allocation-id <eip-alloc-id>
#   aws ec2 delete-security-group --group-id <sg-id>

set -euo pipefail

# ── Config ───────────────────────────────────────────────────────────────────
REGION="${REGION:-ap-southeast-1}"           # Singapore — matches Supabase region
INSTANCE_TYPE="${INSTANCE_TYPE:-t3.small}"   # 2 vCPU, 2 GB RAM — plenty for 1-call PoC
MY_KEY_NAME="${MY_KEY_NAME:-voizo-poc-key}"
SG_NAME="voizo-freeswitch-poc-sg"
INSTANCE_NAME="voizo-freeswitch-poc"

# Ubuntu 22.04 LTS AMI in ap-southeast-1 (verify before running — AMIs change)
# Lookup: aws ec2 describe-images --owners 099720109477 --filters "Name=name,Values=ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*" --query "Images | sort_by(@, &CreationDate) | [-1].ImageId"
AMI_ID="${AMI_ID:-ami-04276e4268f59d644}"   # Debian 11 (bullseye) ap-southeast-1, verified 2026-04-15 — FS repo requires Debian

# ── Auto-detect your IP for SSH access ────────────────────────────────────────
MY_IP="$(curl -s ifconfig.me)/32"
echo "[+] Your IP: $MY_IP (will be allowed SSH access)"

# ── Create security group ────────────────────────────────────────────────────
echo "[+] Creating security group: $SG_NAME"
SG_ID=$(aws ec2 create-security-group \
  --region "$REGION" \
  --group-name "$SG_NAME" \
  --description "Voizo FreeSWITCH PoC: SSH from my IP, SIP/RTP from anywhere" \
  --query 'GroupId' --output text)
echo "[+] SG ID: $SG_ID"

# SSH from my IP only
aws ec2 authorize-security-group-ingress --region "$REGION" \
  --group-id "$SG_ID" --protocol tcp --port 22 --cidr "$MY_IP"

# SIP signaling: 5060/5080 UDP from anywhere
# (SquareTalk's source IPs aren't published — narrow this in production)
aws ec2 authorize-security-group-ingress --region "$REGION" \
  --group-id "$SG_ID" --protocol udp --port 5060 --cidr 0.0.0.0/0
aws ec2 authorize-security-group-ingress --region "$REGION" \
  --group-id "$SG_ID" --protocol udp --port 5080 --cidr 0.0.0.0/0

# RTP media: 16384-32768 UDP from anywhere (matches FS default range)
aws ec2 authorize-security-group-ingress --region "$REGION" \
  --group-id "$SG_ID" --protocol udp --port 16384-32768 --cidr 0.0.0.0/0

# ESL port (8021) — locked to my IP only (used by Voizo dashboard via SSH tunnel
# in the PoC; production would put dashboard inside the same VPC)
aws ec2 authorize-security-group-ingress --region "$REGION" \
  --group-id "$SG_ID" --protocol tcp --port 8021 --cidr "$MY_IP"

# ── User-data script: install FreeSWITCH on first boot ────────────────────────
# Note: uses heredoc WITHOUT quotes (<<EOF not <<'EOF') so $SIGNALWIRE_FS_TOKEN
# from the local shell is interpolated into the user-data before sending to AWS.
# Other $ vars that should execute ON the EC2 box are escaped with \$.
USER_DATA=$(cat <<EOF
#!/bin/bash
set -e
exec > /var/log/voizo-bootstrap.log 2>&1

echo "[bootstrap] Installing FreeSWITCH from SignalWire repo on Debian 11..."
apt-get update
apt-get install -y curl gnupg2 wget lsb-release

# SignalWire repo (token injected at script-generation time from local env)
TOKEN="$SIGNALWIRE_FS_TOKEN"
wget --http-user=signalwire --http-password=\$TOKEN -O /usr/share/keyrings/signalwire-freeswitch-repo.gpg https://freeswitch.signalwire.com/repo/deb/debian-release/signalwire-freeswitch-repo.gpg
echo "machine freeswitch.signalwire.com login signalwire password \$TOKEN" > /etc/apt/auth.conf
echo "deb [signed-by=/usr/share/keyrings/signalwire-freeswitch-repo.gpg] https://freeswitch.signalwire.com/repo/deb/debian-release/ \$(lsb_release -sc) main" > /etc/apt/sources.list.d/freeswitch.list

apt-get update
apt-get install -y freeswitch-meta-all
systemctl enable freeswitch
systemctl start freeswitch

echo "[bootstrap] FreeSWITCH installed successfully."
EOF
)

# ── Launch instance ──────────────────────────────────────────────────────────
echo "[+] Launching EC2 instance ($INSTANCE_TYPE in $REGION)"
INSTANCE_ID=$(aws ec2 run-instances --region "$REGION" \
  --image-id "$AMI_ID" \
  --instance-type "$INSTANCE_TYPE" \
  --key-name "$MY_KEY_NAME" \
  --security-group-ids "$SG_ID" \
  --user-data "$USER_DATA" \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$INSTANCE_NAME},{Key=Project,Value=voizo-freeswitch-poc}]" \
  --query 'Instances[0].InstanceId' --output text)
echo "[+] Instance ID: $INSTANCE_ID"

echo "[+] Waiting for instance to enter 'running' state..."
aws ec2 wait instance-running --region "$REGION" --instance-ids "$INSTANCE_ID"

# ── Allocate + attach Elastic IP ─────────────────────────────────────────────
echo "[+] Allocating Elastic IP"
EIP_OUT=$(aws ec2 allocate-address --region "$REGION" --domain vpc)
EIP=$(echo "$EIP_OUT" | grep -oP '"PublicIp": "\K[^"]+')
EIP_ALLOC=$(echo "$EIP_OUT" | grep -oP '"AllocationId": "\K[^"]+')
echo "[+] Elastic IP: $EIP (allocation: $EIP_ALLOC)"

aws ec2 associate-address --region "$REGION" \
  --instance-id "$INSTANCE_ID" --allocation-id "$EIP_ALLOC"

# ── Output ────────────────────────────────────────────────────────────────────
cat <<SUMMARY

═══════════════════════════════════════════════════════════════════
  Voizo FreeSWITCH PoC — provisioned
═══════════════════════════════════════════════════════════════════
  Instance ID:    $INSTANCE_ID
  Security Group: $SG_ID
  Elastic IP:     $EIP
  Region:         $REGION

  SSH:
    ssh -i ~/.ssh/${MY_KEY_NAME}.pem admin@$EIP

  Bootstrap log (after ~3 min):
    ssh admin@$EIP 'sudo cat /var/log/voizo-bootstrap.log'

  Next steps:
    1. Wait ~3 min for FreeSWITCH installation to complete
    2. SCP the config files:
         scp -i ~/.ssh/${MY_KEY_NAME}.pem infra/freeswitch/sofia.conf.xml admin@$EIP:/tmp/
         scp -i ~/.ssh/${MY_KEY_NAME}.pem infra/freeswitch/dialplan/voizo.xml admin@$EIP:/tmp/
         scp -i ~/.ssh/${MY_KEY_NAME}.pem infra/freeswitch/vars.xml.example admin@$EIP:/tmp/vars.xml
       Then SSH in, fill in vars.xml, sudo mv files into place, systemctl restart freeswitch
    3. Verify SquareTalk registration:
         ssh admin@$EIP 'sudo fs_cli -x "sofia status gateway external::squaretalk"'
    4. Update Voizo .env.local:
         FREESWITCH_HOST=$EIP
         FREESWITCH_ESL_PORT=8021
         FREESWITCH_ESL_PASSWORD=<value-from-vars.xml>
         FREESWITCH_WEBHOOK_SECRET=<random-hex>
    5. Coordinate with Ernie/Maria: add $EIP to Vapi source-IP allow-list
    6. Place test call (Phase 4 of spec)

  Tear down (when PoC is done):
    aws ec2 terminate-instances --region $REGION --instance-ids $INSTANCE_ID
    aws ec2 release-address --region $REGION --allocation-id $EIP_ALLOC
    aws ec2 delete-security-group --region $REGION --group-id $SG_ID
═══════════════════════════════════════════════════════════════════
SUMMARY
