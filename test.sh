#!/usr/bin/env bash
# xfer test suite — exercises the CLI contract and the security defaults.
# Usage: ./test.sh   (exit 0 = all passed)
set -u

ROOT="$(cd "$(dirname "$0")" && pwd)"
XFER="$ROOT/xfer.mjs"
TMP="$(mktemp -d)"
SRC="$TMP/src"; DROP="$TMP/drop"
mkdir -p "$SRC" "$DROP"
sha256() { if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1; else sha256sum "$1" | cut -d' ' -f1; fi; }

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1"; }
check(){ if [ "$2" = "$3" ]; then ok "$1 ($3)"; else bad "$1 (want $3, got $2)"; fi; }

head -c 3145728 /dev/urandom > "$SRC/payload.bin"
printf 'xfer test\n' > "$SRC/note.txt"
SUM_PAYLOAD=$(sha256 "$SRC/payload.bin")
check "sha256 helper returns a real digest" "${#SUM_PAYLOAD}" "64"

# ---------------------------------------------------------------- help ------
echo "help & usage"
"$XFER" -h | grep -q 'SECURITY DEFAULTS'; check "top-level -h" "$?" "0"
"$XFER" --help | grep -q 'xfer recv'; check "top-level --help" "$?" "0"
"$XFER" send -h | grep -q 'allow-sensitive'; check "send -h" "$?" "0"
"$XFER" recv -h | grep -q 'resumes with Range'; check "recv -h" "$?" "0"
"$XFER" -V | grep -q '"version"'; check "version" "$?" "0"
"$XFER" nope >/dev/null 2>&1; check "unknown command exits 2" "$?" "2"
"$XFER" send >/dev/null 2>&1; check "send without args exits 2" "$?" "2"

# ------------------------------------------------------------ sensitive -----
echo "sensitive file guard"
printf 'SECRET=1\n' > "$SRC/.env"
"$XFER" send "$SRC/.env" > "$TMP/sens.json" 2>&1; check "refuses .env" "$?" "1"
grep -q 'secret-looking' "$TMP/sens.json"; check "explains refusal" "$?" "0"

start_sender() { # args: port, extra args...
  local port="$1"; shift
  "$XFER" send "$@" --port "$port" > "$TMP/sender-$port.log" 2>&1 &
  echo $! > "$TMP/pid-$port"
  disown $! 2>/dev/null || true
  for _ in $(seq 1 50); do
    grep -q '"event":"ready"' "$TMP/sender-$port.log" 2>/dev/null && return 0
    sleep 0.1
  done
  return 1
}
token_of() { grep -o '"token":"[^"]*"' "$TMP/sender-$1.log" | head -1 | cut -d'"' -f4; }
bind_of()  { grep -o '"bind":"[^"]*"'  "$TMP/sender-$1.log" | head -1 | cut -d'"' -f4; }
base_of()  { grep -o '"baseUrls":\["[^"]*"' "$TMP/sender-$1.log" | head -1 | cut -d'"' -f4; }
origin_of(){ local b x; b=$(base_of "$1"); x="${b%%\?*}"; echo "${x%/}"; }
stop()     { kill "$(cat "$TMP/pid-$1")" 2>/dev/null; }

# ------------------------------------------------------- default bind -------
echo "secure defaults"
start_sender 8801 "$SRC/note.txt" --ttl 40 --max-downloads 0 || bad "sender 8801 start"
check "binds loopback by default" "$(bind_of 8801)" "127.0.0.1"
grep -q '"event":"warn"' "$TMP/sender-8801.log"; check "no LAN warning when loopback" "$?" "1"

BASE=$(base_of 8801); TOKEN=$(token_of 8801)
"$XFER" info "$BASE" >/dev/null 2>&1; check "info with token" "$?" "0"
curl -s -o /dev/null -w '%{http_code}' "$(origin_of 8801)/?t=wrongtoken" > "$TMP/code"; check "bad token → 401" "$(cat "$TMP/code")" "401"
curl -s -o /dev/null -w '%{http_code}' -H "X-Xfer-Token: $TOKEN" "$(origin_of 8801)/" > "$TMP/code2"; check "header token works" "$(cat "$TMP/code2")" "200"
stop 8801

# ------------------------------------------------------------ integrity -----
echo "transfer integrity"
start_sender 8802 "$SRC/payload.bin" "$SRC/note.txt" --ttl 40 --max-downloads 0 || bad "sender 8802 start"
BASE=$(base_of 8802)
"$XFER" recv "$BASE" --out "$DROP" >/dev/null 2>&1; check "recv exit" "$?" "0"
check "checksum" "$(sha256 "$DROP/payload.bin")" "$SUM_PAYLOAD"
"$XFER" recv "$BASE" --out "$DROP" 2>/dev/null | grep -q '"skipped":"already-complete"'; check "skip when complete" "$?" "0"

# resume from a 1 MiB partial
head -c 1048576 "$SRC/payload.bin" > "$DROP/payload.bin.part"
rm -f "$DROP/payload.bin"
"$XFER" recv "$BASE" --out "$DROP" --only payload.bin 2>/dev/null | grep -q '"resumedFrom":1048576'; check "resumes from partial" "$?" "0"
check "resumed checksum" "$(sha256 "$DROP/payload.bin")" "$SUM_PAYLOAD"
stop 8802

# ------------------------------------------------------------- one-shot -----
echo "download limits"
start_sender 8803 "$SRC/note.txt" "$SRC/payload.bin" --ttl 40 || bad "sender 8803 start"
BASE=$(base_of 8803)
curl -s -o /dev/null "$(origin_of 8803)/f/note.txt?t=$(token_of 8803)"; check "first download" "$?" "0"
curl -s -o /dev/null -w '%{http_code}' "$(origin_of 8803)/f/note.txt?t=$(token_of 8803)" > "$TMP/code3"
check "second download → 410" "$(cat "$TMP/code3")" "410"
stop 8803

# --------------------------------------------------------------- cidr -------
echo "address allowlist"
start_sender 8804 "$SRC/note.txt" --ttl 40 --max-downloads 0 --allow-cidr 10.0.0.0/8 || bad "sender 8804 start"
curl -s -o /dev/null -w '%{http_code}' "$(base_of 8804)" > "$TMP/code4"
check "loopback outside allowlist → 403" "$(cat "$TMP/code4")" "403"
stop 8804

# ------------------------------------------------------------ lockout -------
echo "token brute-force lockout"
start_sender 8805 "$SRC/note.txt" --ttl 40 --max-downloads 0 || bad "sender 8805 start"
HOSTPORT="${BASE_HOST:-http://127.0.0.1:8805}"
for i in 1 2 3 4 5; do curl -s -o /dev/null "$HOSTPORT/?t=bad$i"; done
curl -s -o /dev/null -w '%{http_code}' "$HOSTPORT/?t=bad6" > "$TMP/code5"
check "6th attempt → 429" "$(cat "$TMP/code5")" "429"
grep -q '"event":"blocked"' "$TMP/sender-8805.log"; check "lockout audited" "$?" "0"
grep -q "bad6" "$TMP/sender-8805.log"; check "no token in logs" "$?" "1"
stop 8805

# ---------------------------------------------------------------- tls -------
if command -v openssl >/dev/null 2>&1; then
  echo "TLS"
  openssl req -x509 -newkey rsa:2048 -nodes -keyout "$TMP/key.pem" -out "$TMP/cert.pem" \
    -days 1 -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1" >/dev/null 2>&1
  start_sender 8806 "$SRC/note.txt" --ttl 40 --max-downloads 0 \
    --tls-cert "$TMP/cert.pem" --tls-key "$TMP/key.pem" || bad "sender 8806 start"
  grep -q '"tls":true' "$TMP/sender-8806.log"; check "serves https" "$?" "0"
  "$XFER" recv "$(base_of 8806)" --out "$TMP/drop-tls" --insecure >/dev/null 2>&1; check "recv --insecure" "$?" "0"
  stop 8806
else
  echo "TLS — skipped (openssl missing)"
fi

# ------------------------------------------------- phone / tablet / laptop --
echo "phone / tablet / computer"
mkdir -p "$TMP/inbox"
start_sender 8807 "$SRC/note.txt" --ttl 40 --max-downloads 0 --web --upload "$TMP/inbox" || bad "sender 8807 start"
CODE7=$(grep -o '"code":"[^"]*"' "$TMP/sender-8807.log" | head -1 | cut -d'"' -f4)
H7="http://127.0.0.1:8807"
grep -q '"phoneUrl"' "$TMP/sender-8807.log"; check "ready advertises phoneUrl" "$?" "0"
curl -s "$H7/?k=$CODE7" | grep -q 'id="files"'; check "web page served" "$?" "0"
curl -s "$H7/?k=$CODE7" | grep -q "k=$CODE7"; check "page carries short-code auth" "$?" "0"
curl -s "$H7/index.json?k=$CODE7" | grep -q '"name":"note.txt"'; check "short code reads index" "$?" "0"
curl -s -o /dev/null -w '%{http_code}' "$H7/index.json?k=zzzzzz" > "$TMP/c7"; check "wrong code -> 401" "$(cat "$TMP/c7")" "401"
curl -s -o /dev/null -w '%{http_code}' "$H7/f/note.txt?k=$CODE7" > "$TMP/c8"; check "download by short code" "$(cat "$TMP/c8")" "200"
head -c 300000 /dev/urandom > "$TMP/fromphone.bin"
curl -s -X PUT --data-binary @"$TMP/fromphone.bin" "$H7/u/fromphone.bin?k=$CODE7" | grep -q '"ok":true'; check "phone upload accepted" "$?" "0"
check "uploaded checksum" "$(sha256 "$TMP/inbox/fromphone.bin")" "$(sha256 "$TMP/fromphone.bin")"
curl -s -X PUT --data-binary "again" "$H7/u/fromphone.bin?k=$CODE7" > /dev/null
ls "$TMP/inbox" | grep -q 'fromphone-1.bin'; check "never overwrites" "$?" "0"
rm -rf "$TMP/drop-code"
"$XFER" recv "$H7/?k=$CODE7" --out "$TMP/drop-code" >/dev/null 2>&1; check "recv via ?k" "$?" "0"
check "recv-by-code checksum" "$(sha256 "$TMP/drop-code/note.txt")" "$(sha256 "$SRC/note.txt")"
stop 8807

start_sender 8808 "$SRC/note.txt" --ttl 40 --max-downloads 0 --upload "$TMP/inbox" --max-upload 1 || bad "sender 8808 start"
CODE8=$(grep -o '"code":"[^"]*"' "$TMP/sender-8808.log" | head -1 | cut -d'"' -f4)
head -c 2097152 /dev/urandom > "$TMP/too-big.bin"
curl -s -o /dev/null -w '%{http_code}' -X PUT --data-binary @"$TMP/too-big.bin" "http://127.0.0.1:8808/u/too-big.bin?k=$CODE8" > "$TMP/c9"
check "upload cap -> 413" "$(cat "$TMP/c9")" "413"
ls "$TMP/inbox" | grep -q 'too-big.bin'; check "oversized upload not kept" "$?" "1"
stop 8808

start_sender 8809 "$SRC/note.txt" --ttl 40 --max-downloads 0 || bad "sender 8809 start"
CODE9=$(grep -o '"code":"[^"]*"' "$TMP/sender-8809.log" | head -1 | cut -d'"' -f4)
curl -s -o /dev/null -w '%{http_code}' -X PUT --data-binary "x" "http://127.0.0.1:8809/u/x.txt?k=$CODE9" > "$TMP/c10"
check "upload disabled -> 403" "$(cat "$TMP/c10")" "403"
stop 8809

# ------------------------------------------------------ versions / updates --
echo "versioning"
"$XFER" -V | grep -q '"proto":1'; check "version reports proto" "$?" "0"
"$XFER" doctor | grep -q '"installPath"'; check "doctor reports install path" "$?" "0"
"$XFER" doctor | grep -q '"onPathMatches"'; check "doctor detects PATH shadowing" "$?" "0"

node -e "require('http').createServer((q,s)=>{s.writeHead(200,{'content-type':'application/json'});s.end(JSON.stringify({proto:99,app:'9.9.9',files:[]}))}).listen(8811)" &
FAKE=$!
sleep 0.8
"$XFER" recv "http://127.0.0.1:8811/?t=x" > "$TMP/proto.json" 2>&1
check "unknown proto refused" "$?" "1"
grep -q 'protocol mismatch' "$TMP/proto.json"; check "proto mismatch explained" "$?" "0"
kill "$FAKE" 2>/dev/null

install_out=$(HOME="$TMP/home" sh "$ROOT/install.sh" --version 0.3.0 --base "file://$ROOT" 2>&1)
echo "$install_out" | grep -q 'installed 0.3.0'; check "installer installs versioned copy" "$?" "0"
HOME="$TMP/home" sh "$ROOT/install.sh" --check --version 0.3.0 >/dev/null 2>&1; check "installer --check says up-to-date" "$?" "0"
HOME="$TMP/home" sh "$ROOT/install.sh" --version 0.3.1 --base "file://$ROOT" >/dev/null 2>&1
HOME="$TMP/home" sh "$ROOT/install.sh" --rollback >/dev/null 2>&1
check "rollback restores previous" "$(cat "$TMP/home/.local/xfer/current")" "0.3.0"

# ------------------------------------------------------------------ windows --
echo "windows packaging"
[ -f "$ROOT/install.ps1" ]; check "install.ps1 present" "$?" "0"
grep -q 'Get-FileHash' "$ROOT/install.ps1"; check "ps installer verifies checksums" "$?" "0"
grep -q 'xfer.cmd' "$ROOT/install.ps1"; check "ps installer writes the shim" "$?" "0"
grep -q -- '-Rollback' "$ROOT/install.ps1"; check "ps installer supports rollback" "$?" "0"
[ -f "$ROOT/xfer.cmd" ]; check "xfer.cmd shipped for manual installs" "$?" "0"
if command -v file >/dev/null 2>&1; then
  file "$ROOT/xfer.cmd" | grep -q CRLF; check "xfer.cmd uses CRLF" "$?" "0"
fi
grep -q '\*.cmd text eol=crlf' "$ROOT/.gitattributes"; check "gitattributes pins CRLF for .cmd" "$?" "0"
node "$XFER" -V | grep -q '"version":"0.3.1"'; check "version bumped" "$?" "0"

# --------------------------------------------------------------- report -----
rm -rf "$TMP"
printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
