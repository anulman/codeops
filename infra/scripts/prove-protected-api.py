#!/usr/bin/python3
"""Real RBAC refusals against an ephemeral loopback-only API, not production.
Operator fixture supplies pinned etcd/kube-apiserver/kubectl in ./bin. Run only
inside the credential-free network-none test container; no external kubeconfig.
"""
import json, os, pathlib, secrets, subprocess, time
root=pathlib.Path.cwd()
env={'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':'/tmp'}
children=[]
proofs=[]
def command(args, *, data=None):
    return subprocess.run(args,input=data,env=env,capture_output=True,timeout=180)
def check(condition, message):
    if not condition: raise RuntimeError(message)
def kubectl(who,*args,data=None):
    return command([str(root/'bin/kubectl'),'--kubeconfig',str(root/(who+'.json')),*args],data=data)
def apply(obj):
    result=kubectl('admin','apply','-f','-',data=json.dumps(obj).encode())
    check(result.returncode==0,'Disposable fixture provisioning failed')
def resource(kind,name,namespace,**extra):
    api='v1'
    if kind in ('Role','RoleBinding'):api='rbac.authorization.k8s.io/v1'
    return {'apiVersion':api,'kind':kind,'metadata':{'name':name,**({'namespace':namespace} if namespace else {})},**extra}
try:
    # No host-provided tokens. These ephemeral fixture tokens never leave tmpfs.
    users={'admin':('fixture-admin','system:masters'),
           'runtime':('system:serviceaccount:agents-system:codeops-control-gateway','system:serviceaccounts'),
           'inspector':('system:serviceaccount:codeops-inspection:codeops-inspector','system:serviceaccounts')}
    rows=[]
    for key,(username,group) in users.items():
        token=secrets.token_hex(32)
        rows.append(','.join([token,username,key,group]))
        config={'apiVersion':'v1','kind':'Config','clusters':[{'name':'disposable','cluster':{'server':'https://127.0.0.1:6443','certificate-authority':str(root/'cert.pem')}}],
                'users':[{'name':key,'user':{'token':token}}],
                'contexts':[{'name':'fixture','context':{'cluster':'disposable','user':key}}],'current-context':'fixture'}
        path=root/(key+'.json');path.write_text(json.dumps(config));path.chmod(0o600)
    (root/'tokens.csv').write_text('\n'.join(rows));(root/'tokens.csv').chmod(0o600)
    check(command(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(root/'key.pem'),'-out',str(root/'cert.pem'),'-days','1','-subj','/CN=disposable-api','-addext','subjectAltName=IP:127.0.0.1']).returncode==0,'Synthetic certificate generation failed')
    processes=[['bin/etcd','--data-dir=/tmp/etcd','--listen-client-urls=http://127.0.0.1:2379','--advertise-client-urls=http://127.0.0.1:2379','--listen-peer-urls=http://127.0.0.1:2380'],
      ['bin/kube-apiserver','--etcd-servers=http://127.0.0.1:2379','--bind-address=127.0.0.1','--advertise-address=127.0.0.1','--secure-port=6443','--authorization-mode=RBAC','--anonymous-auth=false',
       '--token-auth-file='+str(root/'tokens.csv'),'--tls-cert-file='+str(root/'cert.pem'),'--tls-private-key-file='+str(root/'key.pem'),'--client-ca-file='+str(root/'cert.pem'),
       '--service-account-signing-key-file='+str(root/'key.pem'),'--service-account-key-file='+str(root/'cert.pem'),'--service-account-issuer=https://disposable.invalid','--service-cluster-ip-range=10.96.0.0/24']]
    for args in processes:
        log=open(root/(pathlib.Path(args[0]).name+'.log'),'wb')
        children.append(subprocess.Popen(args,env=env,stdout=log,stderr=log))
        log.close()
    for _ in range(100):
        result=kubectl('admin','get','--raw=/readyz')
        if result.returncode==0:break
        check(all(p.poll() is None for p in children),'Disposable API process stopped')
        time.sleep(.2)
    check(result.returncode==0,'Disposable API readiness failed')
    for ns in ('agents-system','codeops-database-owner','codeops-inspection'):
        apply(resource('Namespace',ns,None))
    # The real candidate Role/RoleBinding and network manifests are parsed by
    # kubectl against this API, not mirrored into an in-memory authorization model.
    result=kubectl('admin','apply','-f','protected-boundary.yaml')
    check(result.returncode==0,'Candidate protected boundary failed API validation')
    apply(resource('ServiceAccount','codeops-control-gateway','agents-system'))
    apply(resource('Role','runtime-broad-namespace','agents-system',rules=[{'apiGroups':[''],'resources':['secrets','pods','pods/exec'],'verbs':['get','list','create']},{'apiGroups':['batch'],'resources':['jobs'],'verbs':['get','list','create']}]))
    apply(resource('RoleBinding','runtime-broad-namespace','agents-system',subjects=[{'kind':'ServiceAccount','name':'codeops-control-gateway','namespace':'agents-system'}],roleRef={'apiGroup':'rbac.authorization.k8s.io','kind':'Role','name':'runtime-broad-namespace'}))
    for ns in ('agents-system','codeops-database-owner'):
        apply(resource('Secret','synthetic-sentinel',ns,type='Opaque',data={}))
    # Replace the bootstrap fixture tokens with actual short-lived TokenRequest
    # ServiceAccount credentials before testing the intended identities.
    for who,namespace,name in [('runtime','agents-system','codeops-control-gateway'),('inspector','codeops-inspection','codeops-inspector')]:
        issued=kubectl('admin','create','token',name,'--namespace',namespace,'--duration=10m')
        check(issued.returncode==0, 'Disposable ServiceAccount token issuance failed')
        config_path=root/(who+'.json')
        config=json.loads(config_path.read_text())
        config['users'][0]['user']['token']=issued.stdout.decode().strip()
        config_path.write_text(json.dumps(config))
    for who in ('runtime','inspector'):
        identity=kubectl(who,'auth','whoami','-o','json')
        check(identity.returncode==0 and json.loads(identity.stdout)['status']['userInfo']['username']==users[who][0],'Actor identity mismatch')
        positive=kubectl(who,'get','pods','-n','agents-system','-o','name')
        check(positive.returncode==0,'Positive runtime-namespace read failed')
        proofs.append(who+': positive identity and allowed Pod read')
        operations=[['get','secret/synthetic-sentinel','-n','codeops-database-owner','-o','name'],
                    ['get','pods','-n','codeops-database-owner','-o','name'],
                    ['get','--raw=/api/v1/namespaces/codeops-database-owner/pods/synthetic-db/exec?command=true&stdin=false&stdout=false&stderr=false'],
                    ['get','pods','-n','agents-system','--as=fixture-admin']]
        for args in operations:
            refusal=kubectl(who,*args)
            check(refusal.returncode!=0 and b'Forbidden' in refusal.stderr,'Expected API authorization refusal missing')
            proofs.append(who+': refused '+args[1].split('?')[0])
        # Server dry-run avoids creating anything even if a regression allows it.
        for obj in [dict(resource('Job','synthetic-denied','codeops-database-owner',spec={'template':{'spec':{'restartPolicy':'Never','containers':[{'name':'probe','image':'invalid.example/never-pulled:fixture'}]}}}),apiVersion='batch/v1'),
                    resource('RoleBinding','synthetic-escalation','codeops-database-owner',subjects=[{'kind':'ServiceAccount','name':'codeops-control-gateway','namespace':'agents-system'}],roleRef={'apiGroup':'rbac.authorization.k8s.io','kind':'ClusterRole','name':'cluster-admin'})]:
            refusal=kubectl(who,'create','--dry-run=server','-f','-',data=json.dumps(obj).encode())
            check(refusal.returncode!=0 and b'Forbidden' in refusal.stderr,'Expected dry-run create refusal missing')
            proofs.append(who+': refused '+obj['kind']+' creation in owner namespace')
    result=kubectl('runtime','get','secret/synthetic-sentinel','-n','agents-system','-o','name')
    check(result.returncode==0,'Runtime positive Secret read missing')
    result=kubectl('inspector','get','secret/synthetic-sentinel','-n','agents-system','-o','name')
    check(result.returncode!=0 and b'Forbidden' in result.stderr,'Inspector runtime Secret read not refused')
    proofs.append('inspector: runtime Secret refused; runtime positive control allowed')
    print(json.dumps({'result':'PASS','proofCount':len(proofs),'proofs':proofs,'scope':'real disposable API RBAC; no scheduler, CNI, real Helm upgrade, or production mutation'}))
    helm_proof = command(['/usr/bin/python3', '-I', '-B', 'prove-helm-hook-cutover.py'])
    check(helm_proof.returncode == 0, 'Helm/API cutover fixture failed: ' + helm_proof.stderr.decode()[-1200:])
    print(helm_proof.stdout.decode(), end='')
finally:
    for process in reversed(children):
        process.terminate()
        try:process.wait(timeout=10)
        except subprocess.TimeoutExpired:process.kill();process.wait()
