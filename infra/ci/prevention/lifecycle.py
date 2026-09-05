"""Real Helm migration slice, SQL connections, workload and policy qualification.

The slice retains shipped migration/credential templates verbatim. Plane,
Temporal, provider services and production storage are deliberately not installed.
"""
import base64
import copy
import hashlib
import json
from pathlib import Path
import time
import uuid

import yaml
import cluster as c

SECURITY = {'runAsNonRoot': True, 'runAsUser': 1000, 'runAsGroup': 1000,
            'seccompProfile': {'type': 'RuntimeDefault'}}
CONTAINER_SECURITY = {'allowPrivilegeEscalation': False, 'readOnlyRootFilesystem': True,
                      'capabilities': {'drop': ['ALL']}}


def obj(kind, name, ns=None, **fields):
    api = {'Deployment': 'apps/v1', 'Job': 'batch/v1', 'NetworkPolicy': 'networking.k8s.io/v1',
           'Role': 'rbac.authorization.k8s.io/v1', 'RoleBinding': 'rbac.authorization.k8s.io/v1'}.get(kind, 'v1')
    return {'apiVersion': api, 'kind': kind, 'metadata': {'name': name, **({'namespace': ns} if ns else {})}, **fields}


def image(pin):
    return c.LOADED.get(pin, pin)


def diagnose(ns):
    # Fixed namespace, bounded status/log tails, no Secret specs or environments.
    import re
    def clean(text):
        return re.sub(r'postgres(?:ql)?://[^\s]+|[A-Za-z0-9._~-]{32,}', '[redacted]', text[-4000:])
    events = c.kubectl('-n', ns, 'get', 'events', '--field-selector', 'type=Warning', '-o', 'json', ok=False)
    pods = c.kubectl('-n', ns, 'get', 'pods', '-o', 'json', ok=False)
    data = {'warnings': clean(events.stdout), 'pods': []}
    if pods.returncode == 0:
        for p in json.loads(pods.stdout)['items'][:8]:
            data['pods'].append({'name': p['metadata']['name'], 'status': clean(json.dumps(p.get('status', {})))})
    for selector in ('app=db', 'app.kubernetes.io/component=session-migration'):
        logs = c.kubectl('-n', ns, 'logs', '-l', selector, '--all-containers', '--tail=20', ok=False, timeout=20)
        data[selector] = clean(logs.stdout + logs.stderr)
    c.record(ns + '-failure-diagnostics', data)


def get(ns, kind, name):
    return json.loads(c.kubectl('-n', ns, 'get', kind, name, '-o', 'json').stdout)


def pod(image, command, labels=None, token=False):
    return {'metadata': {'labels': labels or {}}, 'spec': {
        'automountServiceAccountToken': token, 'enableServiceLinks': False,
        'securityContext': SECURITY, 'restartPolicy': 'Never',
        'containers': [{'name': 'test', 'image': image, 'imagePullPolicy': 'Never',
                        'command': command, 'securityContext': CONTAINER_SECURITY,
                        'resources': {'limits': {'memory': '256Mi', 'cpu': '500m'},
                                      'requests': {'memory': '32Mi', 'cpu': '10m'}}}]}}


def job(ns, name, template, success=True):
    c.apply(obj('Job', name, ns, spec={'backoffLimit': 0, 'activeDeadlineSeconds': 120, 'template': template}))
    status = c.wait(lambda: (s if s.get('succeeded') or s.get('failed') else None)
                    if (s := get(ns, 'job', name).get('status', {})) else None, 150)
    if bool(status.get('succeeded')) != success:
        diagnose(ns)
        # No raw Job logs: mounted test passwords must not enter artifacts.
        raise AssertionError('Job outcome mismatch: ' + name)
    pods = json.loads(c.kubectl('-n', ns, 'get', 'pods', '-l', 'job-name=' + name, '-o', 'json').stdout)['items']
    if len(pods) != 1:
        raise AssertionError('Job identity ambiguous')
    state = pods[0]['status']['containerStatuses'][0]['state']['terminated']
    c.record(ns + '-' + name, {'jobUid': get(ns, 'job', name)['metadata']['uid'],
                             'podUid': pods[0]['metadata']['uid'], 'imageId': pods[0]['status']['containerStatuses'][0]['imageID'],
                             'exitCode': state['exitCode'], 'expectedSuccess': success})


def sql(ns, query):
    return c.kubectl('-n', ns, 'exec', 'deployment/db', '--', 'psql', '-U', 'agents', '-d', 'agents',
                     '-At', '-v', 'ON_ERROR_STOP=1', '-c', query).stdout.strip()


def ledger(ns):
    return sql(ns, "SELECT migration_name||':'||sha256 FROM codeops.schema_migrations ORDER BY migration_name").splitlines()


def new_case(ns):
    n = obj('Namespace', ns)
    n['metadata']['labels'] = {'pod-security.kubernetes.io/enforce': 'restricted',
                               'pod-security.kubernetes.io/enforce-version': 'v1.33'}
    c.apply(n)
    c.apply(obj('NetworkPolicy', 'default-deny', ns, spec={'podSelector': {}, 'policyTypes': ['Ingress', 'Egress']}),
            obj('NetworkPolicy', 'local-db', ns, spec={'podSelector': {'matchExpressions': [{'key': 'proof', 'operator': 'NotIn', 'values': ['cni']}]}, 'policyTypes': ['Ingress', 'Egress'],
                'ingress': [{'from': [{'podSelector': {}}], 'ports': [{'protocol': 'TCP', 'port': 5432}]}],
                'egress': [{'to': [{'podSelector': {'matchLabels': {'app': 'db'}}}], 'ports': [{'protocol': 'TCP', 'port': 5432}]},
                           {'to': [{'namespaceSelector': {'matchLabels': {'kubernetes.io/metadata.name': 'kube-system'}},
                                    'podSelector': {'matchLabels': {'k8s-app': 'kube-dns'}}}],
                            'ports': [{'protocol': 'UDP', 'port': 53}, {'protocol': 'TCP', 'port': 53}]}]}))
    # API is reachable only by migration Pods. API RBAC remains a separate gate.
    api = get('default', 'service', 'kubernetes')['spec']['clusterIP']
    node_ip = next(a['address'] for a in get('', 'node', c.RUN + '-control-plane')['status']['addresses'] if a['type'] == 'InternalIP')
    c.apply(obj('NetworkPolicy', 'migration-api', ns, spec={
        'podSelector': {'matchLabels': {'app.kubernetes.io/component': 'session-migration'}},
        'policyTypes': ['Egress'], 'egress': [{'to': [{'ipBlock': {'cidr': api + '/32'}},
            {'ipBlock': {'cidr': node_ip + '/32'}}], 'ports': [{'protocol': 'TCP', 'port': 443}, {'protocol': 'TCP', 'port': 6443}]}]}))
    password = uuid.uuid4().hex + uuid.uuid4().hex[:16]
    secret = obj('Secret', 'codeops-postgres', ns, stringData={'password': password})
    secret['metadata'].update(labels={'app.kubernetes.io/managed-by': 'Helm'},
        annotations={'meta.helm.sh/release-name': 'fixture', 'meta.helm.sh/release-namespace': ns})
    c.apply(secret)
    t = pod(image(c.PINS['library/postgres']), ['docker-entrypoint.sh', 'postgres'], {'app': 'db'})
    t['spec']['restartPolicy'] = 'Always'
    t['spec']['securityContext'] = {**SECURITY, 'runAsUser': 999, 'runAsGroup': 999, 'fsGroup': 999}
    ctr = t['spec']['containers'][0]
    ctr['resources']['limits']['memory'] = '512Mi'
    ctr['env'] = [{'name': 'PGDATA', 'value': '/var/lib/postgresql/data/pgdata'}, {'name': 'POSTGRES_USER', 'value': 'agents'}, {'name': 'POSTGRES_DB', 'value': 'agents'},
                  {'name': 'POSTGRES_PASSWORD', 'valueFrom': {'secretKeyRef': {'name': 'codeops-postgres', 'key': 'password'}}}]
    ctr['volumeMounts'] = [{'name': 'data', 'mountPath': '/var/lib/postgresql/data'}, {'name': 'socket', 'mountPath': '/var/run/postgresql'}]
    t['spec']['volumes'] = [{'name': 'data', 'emptyDir': {'sizeLimit': '1Gi'}}, {'name': 'socket', 'emptyDir': {'sizeLimit': '16Mi'}}]
    ctr['readinessProbe'] = {'exec': {'command': ['pg_isready', '-U', 'agents', '-d', 'agents']}, 'periodSeconds': 2}
    c.apply(obj('Deployment', 'db', ns, spec={'replicas': 1, 'selector': {'matchLabels': {'app': 'db'}}, 'template': t}),
            obj('Service', 'codeops-database', ns, spec={'selector': {'app': 'db'}, 'ports': [{'port': 5432}]}))
    try:
        c.kubectl('-n', ns, 'rollout', 'status', 'deployment/db', '--timeout=120s')
    except Exception:
        diagnose(ns)
        raise
    identity = sql(ns, "SELECT current_database()||':'||system_identifier FROM pg_control_system()")
    if not identity.startswith('agents:'):
        raise AssertionError('Wrong disposable database')
    sql(ns, 'CREATE SCHEMA codeops; CREATE TABLE codeops.fixture_writes(id integer PRIMARY KEY, value integer NOT NULL);')
    c.record(ns + '-database', {'namespaceUid': get('', 'namespace', ns)['metadata']['uid'], 'databaseSystem': identity})


WRITER = '''const fs=require('fs'); const {Client}=require('./services/codeops-control-gateway/node_modules/pg');
async function tick(){const c=new Client({connectionString:fs.readFileSync('/db/database-url','utf8').trim()});
await c.connect();await c.query('SELECT migration_name FROM codeops.schema_migrations');
await c.query('INSERT INTO codeops.fixture_writes VALUES(1,1) ON CONFLICT(id) DO UPDATE SET value=codeops.fixture_writes.value+1');await c.end();}
setInterval(()=>tick().catch(()=>process.exit(1)),500);tick().catch(()=>process.exit(1));'''


def chart(source, name, gateway_image):
    """Exact shipped templates, plus one explicitly test-only writer Deployment."""
    directory = c.WORK / name
    (directory / 'templates').mkdir(parents=True)
    original = source / 'infra/charts/codeops'
    hashes = {}
    for file in ('templates/_helpers.tpl', 'templates/migration.yaml', 'templates/quickstart-secrets.yaml', 'values.yaml'):
        b = (original / file).read_bytes()
        (directory / file).write_bytes(b)
        hashes[file] = hashlib.sha256(b).hexdigest()
    (directory / 'Chart.yaml').write_text('apiVersion: v2\nname: prevention-slice\nversion: 0.1.0\n')
    values = yaml.safe_load((directory / 'values.yaml').read_text())
    def digests(tree):
        if isinstance(tree, dict):
            for key, value in tree.items():
                if key in ('digest', 'releaseDigest'):
                    tree[key] = 'sha256:' + '0' * 64
                else:
                    digests(value)
    digests(values)
    repo, digest = gateway_image.split('@')
    values.update(fullnameOverride='fixture')
    values['gateway']['image'] = {'repository': repo, 'digest': digest}
    values['postgresql']['image'] = dict(zip(('repository', 'digest'), image(c.PINS['library/postgres']).split('@')))
    values['quickstart']['enabled'] = True
    values['quickstart']['registry'].update(username='fixture', token='fixture-not-a-credential')
    values['jetstream']['driver'] = 'jetstream'
    values['plane']['adapter']['enabled'] = False
    (directory / 'values.yaml').write_text(yaml.safe_dump(values))
    # Use the actual prior image with application credentials after cutover.
    t = pod(image(c.PINS['alpha72']['image']), ['node', '-e', WRITER], {'app.kubernetes.io/name': 'fixture-session-gateway'})
    t['spec'].update(restartPolicy='Always', volumes=[{'name': 'db', 'secret': {'secretName': 'codeops-session-secrets'}}])
    t['spec']['containers'][0]['volumeMounts'] = [{'name': 'db', 'mountPath': '/db', 'readOnly': True}]
    t['spec']['containers'][0]['readinessProbe'] = {'exec': {'command': ['node', '-e', WRITER.split('setInterval')[0] + 'tick().then(()=>process.exit(0)).catch(()=>process.exit(1));']}, 'periodSeconds': 2, 'timeoutSeconds': 3}
    deployment = obj('Deployment', 'fixture-session-gateway', spec={'replicas': 1,
        'selector': {'matchLabels': t['metadata']['labels']}, 'template': t})
    (directory / 'templates/writer.yaml').write_text(yaml.safe_dump(deployment))
    c.record(name + '-template-inputs', hashes)
    return directory


def helm(ns, directory, upgrade=False, success=True):
    # Real Helm hooks and real migration executable; no fake Job controller.
    result = c.command('helm', 'upgrade' if upgrade else 'install', 'fixture', directory,
                       '--namespace', ns, '--kube-context', 'kind-' + c.RUN,
                       '--wait', '--wait-for-jobs', '--timeout', '300s', ok=False, timeout=330)
    if (result.returncode == 0) != success:
        diagnose(ns)
        raise AssertionError('Helm lifecycle outcome mismatch for ' + ns)
    c.record(ns + '-helm-' + str(time.time_ns()), {'upgrade': upgrade, 'expectedSuccess': success,
                                                'exitCode': result.returncode})


def writer(ns):
    d = get(ns, 'deployment', 'fixture-session-gateway')
    return d['metadata']['uid'], d['spec']['replicas']


def restore(ns, uid):
    d = get(ns, 'deployment', 'fixture-session-gateway')
    if d['metadata']['uid'] != uid or d['spec']['replicas'] != 0:
        raise AssertionError('Writer restoration identity/state drift')
    patch = [{'op': 'test', 'path': '/metadata/uid', 'value': uid},
             {'op': 'test', 'path': '/metadata/resourceVersion', 'value': d['metadata']['resourceVersion']},
             {'op': 'test', 'path': '/spec/replicas', 'value': 0}, {'op': 'replace', 'path': '/spec/replicas', 'value': 1}]
    c.kubectl('-n', ns, 'patch', 'deployment', 'fixture-session-gateway', '--type=json', '-p', json.dumps(patch))
    c.kubectl('-n', ns, 'rollout', 'status', 'deployment/fixture-session-gateway', '--timeout=90s')
    before = int(sql(ns, 'SELECT value FROM codeops.fixture_writes WHERE id=1'))
    c.wait(lambda: int(sql(ns, 'SELECT value FROM codeops.fixture_writes WHERE id=1')) > before, 30)
    c.record(ns + '-restoration-' + str(time.time_ns()), {'uid': uid, 'replicas': 1, 'dmlResumed': True})


def probes(ns, candidate, canary):
    # Unprivileged runtime cannot reach even a canary outside the cluster.
    net = pod(candidate, ['node', '-e', '''const net=require('net');let s=net.connect({host:process.argv[1],port:8080});
s.on('connect',()=>process.exit(1));s.on('error',()=>process.exit(0));s.setTimeout(3000,()=>process.exit(0));''', canary])
    # Explicit allow-all egress removes CNI as a cause: host fence must still deny.
    net['metadata']['labels'] = {'proof': 'external'}
    c.apply(obj('NetworkPolicy', 'external-proof', ns, spec={'podSelector': {'matchLabels': {'proof': 'external'}},
                                                         'policyTypes': ['Egress'], 'egress': [{}]}))
    job(ns, 'external-refusal', net)
    # Actual CNI negative then positive TCP controls against the same local DB.
    for allowed in (False, True):
        if allowed:
            c.apply(obj('NetworkPolicy', 'canary-allow', ns, spec={'podSelector': {'matchLabels': {'proof': 'cni'}},
                'policyTypes': ['Egress'], 'egress': [{'to': [{'podSelector': {'matchLabels': {'app': 'db'}}}],
                                                    'ports': [{'protocol': 'TCP', 'port': 5432}]}]}))
        dbip = get(ns, 'service', 'codeops-database')['spec']['clusterIP']
        t = pod(candidate, ['node', '-e', '''let s=require('net').connect({host:process.argv[1],port:5432});
s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(2));s.setTimeout(3000,()=>process.exit(2));''', dbip], {'proof': 'cni'})
        job(ns, 'cni-' + str(allowed).lower(), t, success=allowed)
    for sa in ('runtime', 'inspector'):
        c.apply(obj('ServiceAccount', sa, ns, automountServiceAccountToken=False))
        for verb, resource in [('get', 'secrets'), ('create', 'jobs'), ('create', 'pods/exec'), ('escalate', 'roles')]:
            resource, _, subresource = resource.partition('/')
            extra = ['--subresource=' + subresource] if subresource else []
            answer = c.kubectl('auth', 'can-i', verb, resource, *extra, '-n', ns,
                               '--as=system:serviceaccount:' + ns + ':' + sa, ok=False).stdout.strip()
            if answer != 'no':
                raise AssertionError('Forbidden runtime authority: ' + sa + ':' + resource)
    c.apply(obj('Role', 'inspect-pods', ns, rules=[{'apiGroups': [''], 'resources': ['pods'], 'verbs': ['get', 'list']}]),
            obj('RoleBinding', 'inspect-pods', ns, subjects=[{'kind': 'ServiceAccount', 'name': 'inspector', 'namespace': ns}],
                roleRef={'apiGroup': 'rbac.authorization.k8s.io', 'kind': 'Role', 'name': 'inspect-pods'}))
    # Use an actual short-lived projected token, not only can-i impersonation.
    request = """const fs=require('fs'),https=require('https');
const root='/var/run/secrets/kubernetes.io/serviceaccount/';
const ns=fs.readFileSync(root+'namespace','utf8').trim();
function req(method,path,body){return new Promise((resolve,reject)=>{
let r=https.request({host:process.env.KUBERNETES_SERVICE_HOST,port:443,method,path,
ca:fs.readFileSync(root+'ca.crt'),headers:{Authorization:'Bearer '+fs.readFileSync(root+'token','utf8').trim(),
'Content-Type':'application/json'},timeout:3000},s=>{s.resume();s.on('end',()=>resolve(s.statusCode))});
r.on('timeout',()=>r.destroy(new Error('timeout')));r.on('error',reject);r.end(body?JSON.stringify(body):undefined);});}
(async()=>{if(await req('GET','/api/v1/namespaces/'+ns+'/pods')!==200)throw Error('positive read');
for(const [method,path,body] of [['GET','/api/v1/namespaces/'+ns+'/secrets/codeops-postgres'],
['POST','/apis/batch/v1/namespaces/'+ns+'/jobs',{apiVersion:'batch/v1',kind:'Job',metadata:{name:'forbidden'},spec:{}}],
['POST','/api/v1/namespaces/'+ns+'/pods/forbidden/exec?command=true&stdout=true']])
if(await req(method,path,body)!==403)throw Error('denial');})().catch(()=>process.exit(1));"""
    api_probe = pod(candidate, ['node', '-e', request], {'app.kubernetes.io/component': 'session-migration'}, token=True)
    api_probe['spec']['serviceAccountName'] = 'inspector'
    job(ns, 'actual-api-denial', api_probe)
    bad = obj('Pod', 'host-escape', ns, spec={'hostNetwork': True, 'containers': [{'name': 'bad', 'image': candidate,
        'securityContext': {'privileged': True}}]})
    rejection = c.kubectl('apply', '-f', '-', data=yaml.safe_dump(bad), ok=False)
    if rejection.returncode == 0 or 'PodSecurity' not in rejection.stderr:
        raise AssertionError('Restricted admission did not reject host privilege')
    c.record(ns + '-denials', {'runtimeAndInspector': 'no secrets/jobs/exec/escalate', 'hostPod': 'refused'})
    app = base64.b64decode(get(ns, 'secret', 'codeops-session-secrets')['data']['database-url']).decode()
    from urllib.parse import urlsplit, urlunsplit
    parts = urlsplit(app)
    password = parts.password
    if not password.isalnum():
        raise AssertionError('Fixture password encoding changed')
    sql(ns, f"CREATE ROLE fixture_inspector LOGIN PASSWORD '{password}'; GRANT codeops_inspector TO fixture_inspector;")
    inspector = urlunsplit(parts._replace(netloc='fixture_inspector:' + password + '@' + parts.hostname + ':5432'))
    c.apply(obj('Secret', 'fixture-inspector', ns, stringData={'database-url': inspector}))
    source = Path(__file__).with_name('roles.mjs').read_text()
    t = pod(candidate, ['node', '--input-type=module', '-e', source])
    t['spec']['volumes'] = [{'name': 'db', 'secret': {'secretName': 'codeops-session-secrets'}},
                            {'name': 'proxy', 'secret': {'secretName': 'codeops-model-proxy-credentials'}},
                            {'name': 'relay', 'secret': {'secretName': 'codeops-lifecycle-relay'}},
                            {'name': 'inspector', 'secret': {'secretName': 'fixture-inspector'}}]
    t['spec']['containers'][0]['volumeMounts'] = [{'name': 'db', 'mountPath': '/db', 'readOnly': True},
                                                {'name': 'proxy', 'mountPath': '/proxy', 'readOnly': True},
                                                {'name': 'relay', 'mountPath': '/relay', 'readOnly': True},
                                                {'name': 'inspector', 'mountPath': '/inspector', 'readOnly': True}]
    job(ns, 'role-connections', t)


def run(candidate, canary):
    pinned = c.LOADED[candidate]
    current = chart(c.ROOT, 'candidate-chart', pinned)
    prior72 = chart(c.ROOT / 'prior72', 'alpha72-chart', image(c.PINS['alpha72']['image']))
    prior69 = chart(c.ROOT / 'prior69', 'alpha69-chart', image(c.PINS['alpha69']['image']))
    fresh = 'fresh'
    new_case(fresh)
    helm(fresh, current)
    if len(ledger(fresh)) != 29:
        raise AssertionError('Fresh schema incomplete')
    probes(fresh, pinned, canary)
    # Invalid mounted application identity must fail BEFORE writer quiescence.
    ns = 'prior72'
    new_case(ns); helm(ns, prior72)
    before = ledger(ns); uid, replicas = writer(ns)
    c.apply(obj('Secret', 'codeops-application-database', ns, stringData={'application-database-password': 'bad'}))
    helm(ns, current, upgrade=True, success=False)
    if writer(ns) != (uid, replicas) or ledger(ns) != before:
        raise AssertionError('Invalid input changed writer/schema')
    c.kubectl('-n', ns, 'patch', 'secret', 'codeops-application-database', '--type=merge',
              '-p', json.dumps({'stringData': {'application-database-password': uuid.uuid4().hex + uuid.uuid4().hex[:16]}}))
    helm(ns, current, upgrade=True)
    if ledger(ns) != before:
        raise AssertionError('Same-schema cutover altered history')
    for committed in (False, True):
        ns = 'committed' if committed else 'rollback'
        new_case(ns); helm(ns, prior69)
        before = ledger(ns); uid, _ = writer(ns)
        if len(before) != 28:
            raise AssertionError('Alpha69 must execute its genuine 28 migrations')
        if committed:
            # Fails role provisioning only AFTER all migration transactions commit.
            sql(ns, 'CREATE ROLE fixture_parent; CREATE ROLE codeops_app; GRANT fixture_parent TO codeops_app;')
        else:
            sql(ns, "CREATE FUNCTION public.fixture_fail() RETURNS event_trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'fixture precommit failure'; END$$; CREATE EVENT TRIGGER fixture_fail ON ddl_command_start WHEN TAG IN ('DROP FUNCTION') EXECUTE FUNCTION public.fixture_fail();")
        helm(ns, current, upgrade=True, success=False)
        after = ledger(ns)
        if writer(ns) != (uid, 0) or (len(after) != 29 if committed else after != before):
            raise AssertionError('Failure phase/schema/writer mismatch')
        if committed:
            sql(ns, 'REVOKE fixture_parent FROM codeops_app;')
        else:
            sql(ns, 'DROP EVENT TRIGGER fixture_fail; DROP FUNCTION public.fixture_fail();')
        restore(ns, uid)
        helm(ns, current, upgrade=True)
        final = ledger(ns)
        helm(ns, current, upgrade=True)
        if len(final) != 29 or ledger(ns) != final:
            raise AssertionError('Retry not idempotent')
    # Exercise the prior runtime's actual initialization module, not just pg.
    compatibility = """import fs from 'node:fs';import {createRequire} from 'node:module';
const {Client}=createRequire(process.cwd()+'/services/codeops-control-gateway/package.json')('pg');
const {migrateSessionBroker}=await import(process.cwd()+'/services/codeops-control-gateway/dist/session-broker-migration.js');
const c=new Client({connectionString:fs.readFileSync('/db/database-url','utf8').trim()});
await c.connect();try{await migrateSessionBroker(c);}finally{await c.end();}"""
    t = pod(image(c.PINS['alpha72']['image']), ['node', '--input-type=module', '-e', compatibility])
    t['spec']['volumes'] = [{'name': 'db', 'secret': {'secretName': 'codeops-session-secrets'}}]
    t['spec']['containers'][0]['volumeMounts'] = [{'name': 'db', 'mountPath': '/db', 'readOnly': True}]
    job('prior72', 'prior-initialization-compatibility', t)
    c.record('scope', {'freshInstall': True, 'prior72CredentialCutover': True,
        'prior69NonemptyTransition': True, 'invalidPreQuiescence': True,
        'precommitRollback': True, 'postcommitFailure': True, 'explicitRestore': True,
        'idempotentRetry': True, 'priorImageDml': True,
        'notClaimed': ['full product stack startup', 'cross-node CNI', 'production authority', 'historical admission']})
