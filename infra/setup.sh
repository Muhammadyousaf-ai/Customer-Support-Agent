#!/usr/bin/env bash
# One-time: provision t3.micro + Elastic IP in eu-north-1, write infra/support-ai.pem, bootstrap the host.
# Usage: infra/setup.sh path/to/accessKeys.csv
set -euo pipefail
csv="${1:?usage: $0 accessKeys.csv}"
cd "$(dirname "$0")"

# CSV: header line, then "KEY_ID,SECRET" (strip BOM/CR)
IFS=, read -r AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY < <(sed -n 2p "$csv" | tr -d '\r\357\273\277') || true
[[ -n "${AWS_SECRET_ACCESS_KEY:-}" ]] || { echo "no key row in $csv" >&2; exit 1; }
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_REGION=eu-north-1
unset AWS_PROFILE

aws sts get-caller-identity --query Account --output text >/dev/null
terraform init -input=false
terraform apply -input=false -auto-approve
ip="$(terraform output -raw public_ip)"
# Server bootstrap: Docker, swap, runtime secrets. OpenAI key comes from the repo's local .env (never committed).
key="$(grep -E '^OPENAI_API_KEY=.' ../.env | head -1 | cut -d= -f2-)"
for _ in $(seq 20); do ssh -i support-ai.pem -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 "ubuntu@$ip" true 2>/dev/null && break; sleep 6; done
ssh -i support-ai.pem "ubuntu@$ip" "sudo OPENAI_API_KEY='$key' bash -s" < ../deploy/bootstrap.sh
terraform output -raw ssh; echo
