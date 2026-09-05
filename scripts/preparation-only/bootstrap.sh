#!/bin/bash
set -euo pipefail
# Platform bash/sudo/env/timeout/sha256sum/install are trusted hosted bootstrap.
# Exact reviewed workflow passes manifest hash, SHA, run and attempt; no arbitrary command.
[[ $# == 4 && $1 =~ ^[0-9a-f]{64}$ && $2 =~ ^[0-9a-f]{40}$ && $3 =~ ^[0-9]+$ && $4 =~ ^[0-9]+$ ]]
[[ $EUID == 0 ]]
umask 077
src=$PWD
checks=$(cat <<'EXACT_REVIEWED_HASHES'
c1c3cca30db533600a1b0b4c0537d952ee0b36be2604ad1c9a2f3cce5349e931  ACQUISITION.json
1ab82d55bae8ee583b28d3283490d9aa5b00e6c972e1334a67e9fcc0fc8d190d  ADMISSION-TEMPLATE.json
e8e72794eae4ca8d33570027e8e58c0659a3f9b635cbf72bf7fb3eabf0a98e70  BOOTSTRAP-IDENTITIES.json
c4b44c1f1ed5300dbf1c0fe99a0872df0a2ef58b56317ab878757234aa938c6f  NODE-OCI-RECEIPT.json
c6d30fc3e965327dc5b170ffd42f8f2b0afcf35605feb6722c239fa5dcd1dcf2  NPM-LAYOUT.json
357568d1e53322e976dcdf8de5d033aa5748e46447a785734b297d3d9a41fa4f  PIP-EXCLUSION.json
d218fc7e7d82e6b12853166b9c3ead8faf6fea9556af4c882ac4859e33db4c93  RESOURCE-BUDGET.json
f6b2cc21d0923c0bf4ee91e326b305adc7b40d036530c3347c0e80f7b28ca966  RUNTIME-BUNDLE-MANIFEST.json
b07685179472f6e68e9ab6b8346d75c0c8b6edb5f10fdd32b30e226d3f0ae2fd  RUNTIME-ROOT-PLAN.json
13a62555a3996400ced52bbb600ac9b16c7a1fdcabaaa9d2666ba102a1017d25  SOURCE-BINDING.json
2c2061def4c0b5f2bdc6766236be46e443bdc9109fe994b23a111d112a48d244  SOURCE-REPRODUCTION.json
1bbf25313fa7bcb91a5e9d5719c976d033d728fa6c1b9d7340140d6b21927ba2  USER-DECISION-40460.json
911a6c2baeefb96657b756bef05b6eff5ac52ed3ccd4e4b189eb549db0d77d40  assemble-npm.py
8dfa302a316e6ef229f48178a48dbd8c04b843f470028354040d23dadb07fb81  bounded-disk.py
f53af8c1c829992250e8af8f8e44674d461b9ef2ee8a9179eaebccc732ba7fa4  clean-bindings.py
5180b64e2a409e2c49d82393dce42c4b854e42778a7d6e400a283382e85cb320  control-common.py
0cd18fe90398d955fc8a5569804ac450c8c6633771107c5e744cb2375bb4ee7c  external-collector.py
36aad2dd679f1eb5aef9a260739c372bfff7b733a622292615e56d7272691be6  hosted-supervisor.py
9b573ab541ba5d89bae27c2fd1eca00c7d381c5d24d896ffe19bd715d6a56790  immutable-input.py
4ddad4f5caab86453365afbe921da3a2d1a53e9994e0898995380f5a7bd7bfcd  import-owned.py
ddb3cfcf82193a38f0bbad9035a6bcd3786093e83a048860e5fd8768bb80d56b  node-import.py
9d4800ee688f54ce927c7a62b04a13fce910e45d318a3ab943d2dd2ca9fabcaa  outside-observer.py
a856ee3ddb559d86c499074fcd6be73f040404fa2406ee359bb7ee9968c7fe7b  placement.py
432942b21cb9c0459e51ce85528c92faef970ed08e07878f8d738bee084fee9d  preparation-only.py
1eb676b297acc538cb6b87f487b04ceb743dd65770728a2f10eea38d40161937  public-reconstruct.py
671518ae8b6a66a5e1d1f47979059b2fe1b7156ef07f776c30cc405fddfb27ca  receipt-bridge.py
f4e4a99e58fdc8f5f09156ca00c9cba90066fd2b9401894748756a2730b60d06  runtime-topology.py
13ebbc3f598242b7df91c9bc752b53e3e01fb810c835236bd992e749054abd2a  stage-sealed-input.py
EXACT_REVIEWED_HASHES
)
[[ ! -e /opt/codeops-preparation ]]
/usr/bin/install -d -o root -g root -m 0755 /opt/codeops-preparation
/usr/bin/install -d -o root -g root -m 0700 /opt/codeops-preparation/packet
# Copy only fixed regular source files; compare protected copy against reviewed manifest
# before any candidate Python execution. Checksums are embedded in this pinned script.
while read -r digest name; do
  [[ $digest =~ ^[0-9a-f]{64}$ && $name =~ ^[A-Za-z0-9_.-]+$ && -f $src/$name && ! -L $src/$name ]]
  /usr/bin/install -o root -g root -m 0444 -- "$src/$name" "/opt/codeops-preparation/packet/$name"
done <<< "$checks"
/usr/bin/install -o root -g root -m 0444 PACKET.json /opt/codeops-preparation/packet/PACKET.json
cd /opt/codeops-preparation/packet
printf '%s  PACKET.json\n' "$1" | /usr/bin/sha256sum --strict --check
# Embedded file hashes and protected PACKET bytes are verified before local imports.
printf '%s\n' "$checks" | /usr/bin/sha256sum --strict --check
set +e
/usr/bin/env -i PATH=/usr/bin:/bin LANG=C HOME=/nonexistent TMPDIR=/opt /usr/bin/timeout --signal=TERM --kill-after=10s 600 /usr/bin/python3 -I /opt/codeops-preparation/packet/placement.py "$2" "$3" "$4"
result=$?
# Fixed bridge always runs; placement timeout never initiates cleanup or retry.
/usr/bin/env -i PATH=/usr/bin:/bin LANG=C HOME=/nonexistent TMPDIR=/opt /usr/bin/timeout --signal=TERM --kill-after=5s 30 /usr/bin/python3 -I /opt/codeops-preparation/packet/receipt-bridge.py
bridge_result=$?
[[ $result == 0 && $bridge_result == 0 ]]
