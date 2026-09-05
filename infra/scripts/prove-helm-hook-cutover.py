#!/usr/bin/python3
"""Real Helm/API ordering proof with an explicit synthetic Job controller.
No Pod is scheduled. This proves hook ordering/failure/retry, not migration code.
The companion disposable API fixture must already be ready in this container.
"""
import base64,datetime,json,os,pathlib,subprocess,threading,time
root=pathlib.Path.cwd();env={'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':'/tmp','KUBECONFIG':str(root/'admin.json')}
def run(args,data=None):return subprocess.run(args,input=data,env=env,capture_output=True,timeout=100)
def kube(*args,data=None):return run([str(root/'bin/kubectl'),*args],data)
def require(ok,message):
    if not ok:raise RuntimeError(message)
def secret(name):
    r=kube('get','secret',name,'-n','cutover-fixture','-o','json')
    require(r.returncode==0,'Required staged/prior Secret missing')
    return json.loads(r.stdout)['data']
def decode(data,key):return base64.b64decode(data[key]).decode()
prior=root/'prior';(prior/'templates').mkdir(parents=True)
(prior/'Chart.yaml').write_text('apiVersion: v2\nname: codeops\nversion: 0.0.1\n')
# Synthetic strings only, no real login or credential is ever imported.
password='x'*48
old_url='postgresql://agents:'+password+'@codeops-database:5432/agents'
old=[('codeops-postgres',{'password':password}),('codeops-session-secrets',{'database-url':old_url,'runtime-database-url':'postgresql://codeops_runtime_receipts:'+password+'@codeops-database:5432/agents','runtime-database-role':'codeops_runtime_receipts','runtime-database-password':password}),('codeops-lifecycle-relay',{'database-url':'postgresql://codeops_lifecycle_relay:'+password+'@codeops-database:5432/agents','database-role':'codeops_lifecycle_relay','database-password':password}),('codeops-model-proxy-credentials',{'database-url':'postgresql://codeops_model_proxy:'+password+'@codeops-database:5432/agents','database-role':'codeops_model_proxy','database-password':password})]
(prior/'templates/secrets.yaml').write_text('\n---\n'.join(json.dumps({'apiVersion':'v1','kind':'Secret','metadata':{'name':name,'namespace':'cutover-fixture'},'stringData':data}) for name,data in old))
install=run(['helm','install','codeops',str(prior),'--namespace','cutover-fixture','--create-namespace'])
require(install.returncode==0,'Prior Helm fixture install failed')
prior_data=secret('codeops-session-secrets')
observations=[]
def upgrade(fail):
    errors=[];stop=threading.Event()
    def controller():
        try:
            for _ in range(600):
                if stop.is_set():return
                result=kube('get','job','codeops-session-migrate','-n','cutover-fixture','-o','json')
                if result.returncode:time.sleep(.1);continue
                job=json.loads(result.stdout)
                if job.get('status',{}).get('conditions'):time.sleep(.1);continue
                owner=secret('codeops-migration-secrets');app=secret('codeops-application-database')
                require(decode(owner,'database-url')==old_url,'Prior owner was not preserved')
                require(decode(app,'database-url').startswith('postgresql://codeops_app:'),'New application identity was not staged')
                require(secret('codeops-session-secrets')==prior_data,'Old runtime Secret rotated before migration completion')
                volumes=job['spec']['template']['spec']['volumes']
                require(next(v for v in volumes if v['name']=='application-authority')['secret']['secretName']=='codeops-application-database','Migration did not select staged application Secret')
                observations.append({'failureInjected':fail,'ownerPreserved':True,'applicationStaged':True,'runtimeUnchangedAtHook':True})
                condition={'type':'Failed' if fail else 'Complete','status':'True','reason':'SyntheticFixture','message':'No workload execution: ordering proof only'}
                target={**condition, 'type':'FailureTarget' if fail else 'SuccessCriteriaMet'}
                now=datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z')
                status={'conditions':[target,condition], 'startTime':now, 'failed' if fail else 'succeeded':1}
                if not fail: status['completionTime']=now
                patch=kube('patch','job','codeops-session-migrate','-n','cutover-fixture','--subresource=status','--type=merge','-p',json.dumps({'status':status}))
                require(patch.returncode==0,'Synthetic Job status publication failed: '+patch.stderr.decode()[:800])
                return
            raise RuntimeError('Synthetic hook observer timed out')
        except Exception as error:errors.append(str(error))
    thread=threading.Thread(target=controller);thread.start()
    result=run(['helm','upgrade','codeops','candidate','--namespace','cutover-fixture','--values','candidate/values.yaml','--values','quickstart-values.yaml','--values','immutable-images.yaml','--timeout','45s'])
    stop.set();thread.join(timeout=15)
    require(not errors,'Synthetic controller failed: '+','.join(errors))
    require((result.returncode!=0)==fail,'Helm did not respect hook failure/success')
    return result
upgrade(True)
require(secret('codeops-session-secrets')==prior_data,'Failed upgrade changed old runtime credential')
staged=secret('codeops-application-database')
upgrade(False)
require(secret('codeops-application-database')==staged,'Retry changed staged application identity')
require(secret('codeops-session-secrets')['database-url']==staged['database-url'],'Successful upgrade did not activate staged application identity')
require(len(observations)==2,'Both failure and successful retry were not observed')
print(json.dumps({'result':'PASS','scope':'real Helm install/upgrade API ordering; synthetic Job completion, no workload execution','proofs':['prior owner usable until hook','new application staged before hook','failure preserves prior runtime Secret','retry preserves staged identity','successful hook permits regular application credential cutover'],'observations':observations}))
