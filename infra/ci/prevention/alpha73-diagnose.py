"""One exact published-artifact reproduction on an empty, egress-fenced kind node."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import threading
import time

OUT = Path('/tmp/alpha73-diagnostics')
OUT.mkdir(mode=0o700, exist_ok=True)
NS = 'proof-system'
NODE = 'codeops-registry-control-plane'
CHART = Path('/tmp/codeops-0.5.0-alpha.73.tgz')
SHA = '0b75e6f92e90c10d14becbb256ee05aa0b512df9'
STOP = threading.Event()


def cmd(*args, ok=True, timeout=60):
    p = subprocess.run(args, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    if ok and p.returncode:
        # Never include arguments or arbitrary deployment stdout in errors.
        raise RuntimeError(f'{args[0]} failed: {p.stderr[-1500:]}')
    return p


def k(*args, **kw):
    return cmd('kubectl', '--context', 'kind-codeops-registry', '--request-timeout=8s', *args, **kw)


def collect():
    """Fixed namespace; no Secret, Pod spec/environment, or unbounded logs."""
    seen = set()
    for _ in range(125):
        try:
            p = k('-n', NS, 'get', 'pods', '-o', 'json', ok=False)
            if not p.returncode:
                for pod in json.loads(p.stdout)['items'][:30]:
                    uid = pod['metadata']['uid']
                    if uid not in seen and len(seen) >= 30:
                        continue
                    seen.add(uid)
                    name = pod['metadata']['name']
                    status = pod.get('status', {})
                    states = status.get('initContainerStatuses', []) + status.get('containerStatuses', [])
                    (OUT / (uid + '-states.json')).write_text(json.dumps({
                        'name': name, 'uid': uid, 'phase': status.get('phase'),
                        'containers': [{key: c.get(key) for key in ('name', 'imageID', 'restartCount', 'state', 'lastState')} for c in states[:6]]}))
                    for c in states[:6]:
                        for previous in (False, True):
                            result = k('-n', NS, 'logs', name, '-c', c['name'], '--tail=80', '--limit-bytes=8192',
                                       *(['--previous'] if previous else []), ok=False)
                            if result.returncode == 0 and result.stdout:
                                text = re.sub(r'postgres(?:ql)?://[^\s"\']+', '[database-url-redacted]', result.stdout)
                                (OUT / (uid + '-' + c['name'] + ('-previous' if previous else '-current') + '.log')).write_text(text[:8192])
        except Exception as error:
            (OUT / 'collector-error.txt').write_text(type(error).__name__)
        if STOP.wait(10):
            break


try:
    Path(os.environ['HOME']).mkdir(mode=0o700, exist_ok=True)
    manifest = json.loads(Path('/tmp/codeops-release/release-manifest.json').read_text())
    assert manifest['sourceSha'] == SHA and len(manifest['images']) == 10
    cmd('helm', 'pull', 'oci://ghcr.io/anulman/codeops/charts/codeops', '--version', '0.5.0-alpha.73', '--destination', '/tmp')
    assert hashlib.sha256(CHART.read_bytes()).hexdigest() == 'ba273684128ac888aac2f1996eb291d30596ab8a4029cbc6d79778e7ac79591e'
    rendered = cmd('helm', 'template', NS, str(CHART), '-n', NS, '-f', '/tmp/codeops-quickstart.json').stdout
    images = sorted(set(re.findall(r'^\s+image:\s+[\"\']?([^\s\"\']+)', rendered, re.M)))
    assert images and all('@sha256:' in image for image in images)
    for image in images:
        cmd('docker', 'exec', NODE, 'crictl', 'pull', image, timeout=300)
    # Positive external control, then deny new traffic at node egress. Existing
    # API responses and single-node Pod networking remain; no production target.
    probe = 'timeout 3 bash -c "echo > /dev/tcp/1.1.1.1/443"'
    cmd('docker', 'exec', NODE, 'bash', '-c', probe)
    cmd('docker', 'exec', NODE, 'iptables', '-t', 'mangle', '-I', 'POSTROUTING', '1', '-o', 'eth0', '-m', 'conntrack', '--ctstate', 'NEW', '-j', 'DROP')
    assert cmd('docker', 'exec', NODE, 'bash', '-c', probe, ok=False).returncode != 0
    # Prevent recursive DNS through the host stub; local cluster DNS still works.
    dns = json.loads(k('-n', 'kube-system', 'get', 'configmap', 'coredns', '-o', 'json').stdout)
    core, count = re.subn(r'(?m)^([ \t]+)forward \. /etc/resolv\.conf \{\n(?:[^\n]*\n)*?\1\}\n', '', dns['data']['Corefile'])
    assert count == 1
    dns['data']['Corefile'] = core
    path = Path('/tmp/alpha73-dns.json'); path.write_text(json.dumps(dns))
    k('apply', '-f', str(path))
    k('-n', 'kube-system', 'rollout', 'restart', 'deployment/coredns')
    k('-n', 'kube-system', 'rollout', 'status', 'deployment/coredns', '--timeout=120s', timeout=130)
    (OUT / 'identity.json').write_text(json.dumps({'sourceSha': SHA, 'chartSha256': hashlib.sha256(CHART.read_bytes()).hexdigest(), 'images': images, 'externalBefore': 'allowed', 'externalAfter': 'denied', 'productionAccess': False}))
    worker = threading.Thread(target=collect); worker.start()
    try:
        with (OUT / 'install.log').open('w') as log:
            result = subprocess.run(['node', '/tmp/codeops-release/codeopsctl.mjs', 'deploy', '--lock', '/tmp/codeops-release/codeops-consumer-lock.json', '--values', '/tmp/codeops-quickstart.json', '--policy', '/tmp/codeops-consumer-policy.json', '--release', NS, '--namespace', NS, '--chart-path', str(CHART), '--manifest-path', '/tmp/codeops-release/release-manifest.json'], stdout=log, stderr=log, timeout=1250)
        (OUT / 'result.json').write_text(json.dumps({'installExit': result.returncode, 'samePublishedArtifacts': True}))
        raise SystemExit(result.returncode)
    finally:
        STOP.set(); worker.join(timeout=90)
finally:
    # Workflow owns cluster cleanup after artifact transport, including failure.
    STOP.set()
