"""Trusted disposable CI controller. Never run on a production host or cluster."""
import hashlib
import ipaddress
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import tarfile
import time
import urllib.request
import uuid

import yaml

ROOT = Path(__file__).resolve().parents[3]
PINS = json.loads(Path(__file__).with_name('pins.json').read_text())
RUN = 'prevention-' + uuid.uuid4().hex[:12]
WORK = Path(os.environ['RUNNER_TEMP']) / RUN
EVIDENCE = ROOT / 'prevention-evidence'
ENV = dict(os.environ)
RULES = []
LOADED = {}


def command(*args, data=None, ok=True, timeout=300):
    result = subprocess.run([str(a) for a in args], input=data, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            env=ENV, timeout=timeout)
    if ok and result.returncode:
        # Commands can contain disposable passwords; never print their arguments.
        raise RuntimeError(f'{args[0]} failed ({result.returncode}): {result.stderr[-2000:]}')
    return result


def kubectl(*args, **kwargs):
    return command('kubectl', '--context', 'kind-' + RUN, *args, **kwargs)


def apply(*objects):
    kubectl('apply', '-f', '-', data='\n---\n'.join(yaml.safe_dump(o) for o in objects))


def fetch(pin, path):
    with urllib.request.urlopen(pin['url'], timeout=60) as src, path.open('wb') as out:
        shutil.copyfileobj(src, out, 1024 * 1024)
    if hashlib.sha256(path.read_bytes()).hexdigest() != pin['sha256']:
        raise RuntimeError('Downloaded tool/manifest digest mismatch')


def cluster_only_dns(corefile):
    pattern = r'(?m)^([ \t]+)forward \. /etc/resolv\.conf \{\n(?:[^\n]*\n)*?\1\}\n'
    result, count = re.subn(pattern, '', corefile)
    if count != 1 or re.search(r'(?m)^\s*(forward|proxy)\s', result):
        raise RuntimeError('Unexpected CoreDNS upstream configuration')
    return result


def record(name, value):
    (EVIDENCE / (name + '.json')).write_text(json.dumps(value, indent=2) + '\n')


def wait(predicate, seconds=180):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        result = predicate()
        if result:
            return result
        time.sleep(1)
    raise TimeoutError('Disposable qualification deadline exceeded')


def inspect(kind, name):
    return json.loads(command('docker', kind, 'inspect', name).stdout)[0]


def load_image(image, number):
    # A digest-only Docker pull need not have RepoTags. Give kind a local tag,
    # then bind its imported manifest back to the acquired immutable config.
    tag = RUN + '-image-' + str(number) + ':loaded'
    expected = inspect('image', image)['Id']
    command('docker', 'tag', image, tag)
    command('kind', 'load', 'docker-image', '--name', RUN, tag, timeout=600)
    listing = command('docker', 'exec', RUN + '-control-plane', 'ctr', '-n', 'k8s.io', 'images', 'ls').stdout
    rows = [line.split() for line in listing.splitlines() if line.split() and line.split()[0].endswith('/' + tag)]
    if len(rows) != 1:
        raise RuntimeError('Imported image tag missing or ambiguous')
    ref, _, digest = rows[0][:3]
    manifest = json.loads(command('docker', 'exec', RUN + '-control-plane', 'ctr', '-n', 'k8s.io', 'content', 'get', digest).stdout)
    if manifest.get('config', {}).get('digest') != expected:
        raise RuntimeError('Imported image differs from acquired config')
    pinned = ref.rsplit(':', 1)[0] + '@' + digest
    command('docker', 'exec', RUN + '-control-plane', 'ctr', '-n', 'k8s.io', 'images', 'tag', ref, pinned)
    LOADED[image] = pinned
    record('image-' + str(number), {'source': image, 'config': expected, 'imported': pinned})


def setup():
    if ENV.get('GITHUB_ACTIONS') != 'true' or ENV.get('RUNNER_ENVIRONMENT') != 'github-hosted':
        raise RuntimeError('Only a disposable GitHub-hosted runner is supported')
    if any(k in ENV for k in ('KUBECONFIG', 'DATABASE_URL', 'GH_TOKEN', 'GITHUB_TOKEN', 'AWS_ACCESS_KEY_ID')):
        raise RuntimeError('Controller inherited forbidden authority')
    WORK.mkdir(mode=0o700)
    EVIDENCE.mkdir(exist_ok=False)
    home = WORK / 'home'
    home.mkdir(mode=0o700)
    ENV.update(HOME=str(home), DOCKER_CONFIG=str(home / '.docker'),
               KUBECONFIG=str(WORK / 'kubeconfig'), KIND_EXPERIMENTAL_DOCKER_NETWORK=RUN)
    bindir = WORK / 'bin'
    bindir.mkdir()
    fetch(PINS['kind'], bindir / 'kind')
    (bindir / 'kind').chmod(0o555)
    fetch(PINS['helm'], WORK / 'helm.tgz')
    with tarfile.open(WORK / 'helm.tgz') as archive:
        (bindir / 'helm').write_bytes(archive.extractfile('linux-amd64/helm').read())
    (bindir / 'helm').chmod(0o555)
    ENV['PATH'] = str(bindir) + ':' + ENV['PATH']
    fetch(PINS['calicoManifest'], WORK / 'calico.yaml')
    command('docker', 'network', 'create', '--label', 'codeops.prevention=' + RUN, RUN)
    images = [PINS[k] for k in ('kindNode', 'node', 'library/postgres', 'calico/node', 'calico/cni', 'calico/kube-controllers')]
    images += [PINS[k]['image'] for k in ('alpha69', 'alpha72')]
    for image in images:
        command('docker', 'pull', '--platform=linux/amd64', image, timeout=600)
    # Standard Dockerfile: only ignore-scripts acquisition has networking; all
    # repository-controlled rewriting/compilation RUN instructions use none.
    print('Acquisition complete; building offline candidate', flush=True)
    candidate = RUN + ':candidate'
    command('docker', 'build', '--build-arg', 'NODE_IMAGE=' + PINS['node'],
            '-f', ROOT / 'infra/docker/codeops-control-gateway.Dockerfile',
            '-t', candidate, ROOT, timeout=900)
    config = {'kind': 'Cluster', 'apiVersion': 'kind.x-k8s.io/v1alpha4',
              'networking': {'disableDefaultCNI': True, 'podSubnet': '192.168.0.0/16', 'apiServerAddress': '127.0.0.1'},
              'nodes': [{'role': 'control-plane'}]}
    (WORK / 'kind.yaml').write_text(yaml.safe_dump(config))
    command('kind', 'create', 'cluster', '--name', RUN, '--image', PINS['kindNode'],
            '--config', WORK / 'kind.yaml', '--wait', '0s', timeout=300)
    command('docker', 'cp', RUN + '-control-plane:/usr/bin/kubectl', bindir / 'kubectl')
    (bindir / 'kubectl').chmod(0o555)
    print('Disposable cluster created; loading pinned images', flush=True)
    for number, image in enumerate(images[1:] + [candidate]):
        load_image(image, number)
    calico = (WORK / 'calico.yaml').read_text()
    for key in ('calico/node', 'calico/cni', 'calico/kube-controllers'):
        old = 'docker.io/' + key + ':v3.30.3'
        if old not in calico:
            raise RuntimeError('Unexpected upstream Calico image references')
        calico = calico.replace(old, LOADED[PINS[key]])
    kubectl('apply', '-f', '-', data=calico)
    kubectl('wait', '--for=condition=Ready', 'nodes', '--all', '--timeout=240s')
    kubectl('-n', 'kube-system', 'rollout', 'status', 'daemonset/calico-node', '--timeout=240s')
    kubectl('-n', 'kube-system', 'rollout', 'status', 'deployment/calico-kube-controllers', '--timeout=240s')
    # Canary is outside Kubernetes, but initially reachable on the dedicated
    # Docker bridge. The fence must turn an observed success into a refusal.
    command('docker', 'run', '-d', '--name', RUN + '-canary', '--network', RUN,
            '--memory=64m', '--pids-limit=32', '--read-only', '--cap-drop=ALL',
            '--security-opt=no-new-privileges', '--user=1000', PINS['node'], 'node', '-e',
            'require("http").createServer((q,s)=>s.end("canary")).listen(8080,"0.0.0.0")')
    canary = inspect('container', RUN + '-canary')['NetworkSettings']['Networks'][RUN]['IPAddress']
    node = inspect('container', RUN + '-control-plane')['NetworkSettings']['Networks'][RUN]['IPAddress']
    ipaddress.IPv4Address(node); ipaddress.IPv4Address(canary)
    wait(lambda: command('docker', 'exec', RUN + '-control-plane', 'bash', '-c',
                         f'timeout 2 bash -c "echo > /dev/tcp/{canary}/8080"', ok=False).returncode == 0)
    # Established API responses remain possible; new node->host/bridge/WAN
    # connections do not. Single-node Pod traffic never needs host forwarding.
    for chain in ('DOCKER-USER', 'INPUT'):
        for source in (node + '/32', '192.168.0.0/16'):
            rule = ['-s', source, '-m', 'conntrack', '--ctstate', 'NEW', '-j', 'DROP']
            command('sudo', '-n', 'iptables', '-I', chain, '1', *rule)
            RULES.append((chain, rule))
    # Same-bridge traffic can bypass the host DOCKER-USER chain. Fence at the
    # node's outbound interface as well, before it reaches the bridge. Mangle
    # POSTROUTING covers locally generated AND forwarded Pod traffic, before
    # Calico/Docker SNAT; existing host->API response flows remain permitted.
    node_rule = ['-t', 'mangle', '-I', 'POSTROUTING', '1', '-o', 'eth0',
                 '-m', 'conntrack', '--ctstate', 'NEW', '-j', 'DROP']
    command('docker', 'exec', RUN + '-control-plane', 'iptables', *node_rule)
    check_rule = ['-t', 'mangle', '-C', 'POSTROUTING', '-o', 'eth0',
                  '-m', 'conntrack', '--ctstate', 'NEW', '-j', 'DROP']
    command('docker', 'exec', RUN + '-control-plane', 'iptables', *check_rule)
    if command('docker', 'exec', RUN + '-control-plane', 'bash', '-c',
               f'timeout 2 bash -c "echo > /dev/tcp/{canary}/8080"', ok=False).returncode == 0:
        raise RuntimeError('External fence did not deny its positive control')
    # Cluster-local DNS only: no upstream resolver escape via Docker's stub.
    dns = json.loads(kubectl('-n', 'kube-system', 'get', 'configmap', 'coredns', '-o', 'json').stdout)
    corefile = dns['data']['Corefile']
    dns['data']['Corefile'] = cluster_only_dns(corefile)
    apply(dns)
    kubectl('-n', 'kube-system', 'rollout', 'restart', 'deployment/coredns')
    kubectl('-n', 'kube-system', 'rollout', 'status', 'deployment/coredns', '--timeout=120s')
    free = shutil.disk_usage(WORK).free
    if free < 16 * 1024**3:
        raise RuntimeError('Need >=16 GiB free AFTER image and source staging')
    record('boundary', {'run': RUN, 'candidate': inspect('image', candidate)['Id'],
                        'pins': PINS, 'freeAfterStaging': free, 'outsideCanary': canary,
                        'node': node, 'externalBefore': 'allowed', 'externalAfter': 'denied',
                        'claim': 'single-node disposable CI; not production enforcement'})
    print('External fence and cluster-only DNS proved; starting lifecycle', flush=True)
    return candidate, canary


def cleanup():
    if not WORK.exists():
        return
    # Only names created by this invocation. Never prune global Docker state.
    if (WORK / 'bin/kind').exists():
        command('kind', 'delete', 'cluster', '--name', RUN, ok=False)
    command('docker', 'rm', '-f', RUN + '-canary', ok=False)
    command('docker', 'network', 'rm', RUN, ok=False)
    for chain, rule in reversed(RULES):
        command('sudo', '-n', 'iptables', '-D', chain, *rule, ok=False)


if __name__ == '__main__':
    import sys
    import signal
    def interrupted(*_):
        raise TimeoutError("CI controller interrupted")
    signal.signal(signal.SIGTERM, interrupted)
    sys.modules['cluster'] = sys.modules[__name__]
    import lifecycle
    try:
        candidate, canary = setup()
        lifecycle.run(candidate, canary)
        record('result', {'passed': True, 'run': RUN})
    except Exception as error:
        if EVIDENCE.exists():
            record('result', {'passed': False, 'run': RUN, 'error': str(error)})
        raise
    finally:
        cleanup()
