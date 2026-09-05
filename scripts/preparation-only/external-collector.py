"""Outside observer readiness, ancestry gate and distinct terminal result classes."""
import os,json,time,pathlib,importlib.util
s=importlib.util.spec_from_file_location('c',pathlib.Path(__file__).with_name('control-common.py'));c=importlib.util.module_from_spec(s);s.loader.exec_module(c)
s=importlib.util.spec_from_file_location('observer',pathlib.Path(__file__).with_name('outside-observer.py'));observer=importlib.util.module_from_spec(s);s.loader.exec_module(observer)
def pairs(p):return {line.split()[0].rstrip(':'):int(line.split()[1]) for line in p.read_text().splitlines()}
def read(p):
    fd=c.protected(p)
    try:return c.json_fd(fd)
    finally:os.close(fd)
def unit(tool,name,missing_ok=False):
    try:b=c.command([tool,'show',name,'-p','MainPID','-p','ExecMainCode','-p','ExecMainStatus','-p','Result','-p','ActiveState','-p','InvocationID','-p','ExecMainStartTimestampMonotonic'],cap=65536)
    except ValueError:
        if missing_ok:return {'ActiveState':'not-found','MainPID':'0'}
        raise
    return dict(line.split('=',1) for line in b.decode().splitlines())
TARGETS=['packages/codeops-contracts','services/codeops-control-gateway']
def completion(receipt,a,request):
    c.require(request is not None)
    for k in ['runId','packetSha256','containerId']:c.require(receipt[k]==request[k])
    c.require(receipt['compilers']==[{'target':x,'exitCode':0} for x in TARGETS])
    c.require(receipt['exportPerformed'] is False)

class Monitor:
    """Trusted collector state; workers request but cannot approve teardown."""
    def __init__(self,a):
        self.a=a;self.known={};self.request=None;self.required={};self.phase='running';self.gate=False;self.worker_start=None
    def sample(self,pid,u,request,transition=None):
        was_gated=self.gate
        c.require(u.get('ActiveState')=='active')
        identity={k:u[k] for k in ['InvocationID','ExecMainStartTimestampMonotonic']}
        c.require(bool(identity['InvocationID']) and identity['ExecMainStartTimestampMonotonic']!='0')
        if self.worker_start is None:self.worker_start=identity
        else:c.require(identity==self.worker_start)
        if self.request is not None:c.require(request==self.request)
        elif request is not None:
            for k in ['runId','packetSha256']:c.require(request[k]==self.a[k])
            self.request=json.loads(json.dumps(request))
        # Validate the last RUNNING snapshot before authorizing any disappearance.
        observed=observer.observe(self.a['group'],pid,self.known,self.a,self.request,self.phase)
        live={x['pid']:x['start'] for x in observed['processes']}
        for p,pinned in self.required.items():
            if self.phase=='running':c.require(p in live)
            if p in live:
                current=next(x for x in observed['processes'] if x['pid']==p)
                c.require(all(current[k]==value for k,value in pinned.items()))
        if self.request and not self.gate:
            self.required={x['pid']:{k:x[k] for k in ['start','exe','rootIdentity','net','mnt','group','groupInode','pidNamespace','nspid']} for x in observed['processes']
                if x['pid'] in [r['pid'] for r in observed['roles'].values()] or
                pathlib.Path(x['exe']).name in self.a['daemonHashes']}
            self.gate=True
        transitioned=False
        if transition is not None and self.phase=='running':
            c.require(was_gated);completion(transition,self.a,self.request)
            c.require(transition['phase']=='compilers-complete')
            self.phase='teardown';transitioned=True
        return observed,transitioned
    def finish(self,u,fit,populated,baseline,final):
        c.require(self.phase=='teardown' and self.gate and self.worker_start is not None)
        c.require(all(u[k]==v for k,v in self.worker_start.items()))
        c.require(u.get('MainPID')=='0' and u.get('ActiveState')=='inactive')
        c.require(u.get('Result')=='success' and u.get('ExecMainCode')=='1' and u.get('ExecMainStatus')=='0')
        c.require(populated==0);completion(fit,self.a,self.request)
        c.require(fit['result']=='compiler-exit-zero' and fit['containerStopped'] is True)
        c.require(all(final.get(k,0)==baseline.get(k,0) for k in ['oom','oom_kill','oom_group_kill']))
        return 'compiler-fit-success'

def collect(contract_path):
    a=read(contract_path);group=pathlib.Path(a['group']);state=pathlib.Path(a['state']);root=pathlib.Path(a['runRoot'])
    ident=[group.stat().st_dev,group.stat().st_ino];c.require(ident==a['groupIdentity'])
    mine=observer.proc(os.getpid());c.require(not pathlib.Path(mine['group']).is_relative_to(group))
    baseline=pairs(group/'memory.events');c.require(pairs(group/'cgroup.events')['populated']==0)
    binding={k:a[k] for k in ['runId','packetSha256','group','groupIdentity']}
    c.record(root/'collector-ready.json',{**binding,'collector':mine,'baseline':baseline})
    start=time.monotonic();seen=False;gate=False;reason=None;peak=0;last=None;worker_start=None;monitor=Monitor(a)
    try:
        while time.monotonic()-start<900:
            c.require([group.stat().st_dev,group.stat().st_ino]==ident)
            events=pairs(group/'memory.events');peak=max(peak,int((group/'memory.peak').read_text()))
            if events.get('oom',0)>baseline.get('oom',0) or events.get('oom_kill',0)>baseline.get('oom_kill',0):reason='cgroup-oom';break
            fs=os.statvfs(state)
            if fs.f_bavail*fs.f_frsize<64*1024*1024 or fs.f_favail<1024:reason='disk-floor';break
            if pairs(pathlib.Path('/proc/meminfo'))['MemAvailable']*1024<512*1024*1024:reason='host-memory-floor';break
            u=unit(a['systemctl'],a['workerUnit'],missing_ok=not seen);pid=int(u.get('MainPID','0'))
            if pid:
                seen=True
                request_path=state/'journal/observe-request.json';request=read(request_path) if request_path.exists() else None
                if request:
                    for k in ['runId','packetSha256']:c.require(request[k]==a[k])
                transition_path=state/'journal/teardown-request.json'
                transition=read(transition_path) if transition_path.exists() else None
                observed,transitioned=monitor.sample(pid,u,request,transition)
                worker_start=monitor.worker_start
                if transitioned:
                    c.record(state/'observer-gate/teardown.json',{**binding,'containerId':request['containerId'],'transitionSha256':observer.hashlib.sha256(json.dumps(transition,sort_keys=True).encode()).hexdigest()})
                last=observed
                if request and not gate:
                    c.record(root/'ancestry.json',{**binding,**observed})
                    c.record(state/'observer-gate/ready.json',{**binding,'containerId':request['containerId'],'requestSha256':observer.hashlib.sha256(json.dumps(request,sort_keys=True).encode()).hexdigest()});gate=True
            elif seen and u.get('ActiveState') in ('inactive','failed'):
                reason=monitor.finish(u,read(state/'journal/fit.json'),pairs(group/'cgroup.events')['populated'],baseline,pairs(group/'memory.events'))
                break
            elif not seen and time.monotonic()-start>30:reason='never-started';break
            time.sleep(.1)
        if reason is None:reason='deadline'
    except Exception as error:reason='boundary-refusal';c.record(root/'observer-error.json',{**binding,'errorType':type(error).__name__})
    try:terminal_unit=unit(a['systemctl'],a['workerUnit'],missing_ok=not seen)
    except Exception as error:
        terminal_unit={'observationUnavailable':type(error).__name__}
        if reason=='compiler-fit-success':reason='terminal-observation-lost'
    if reason=='compiler-fit-success':
        try:monitor.finish(terminal_unit,read(state/'journal/fit.json'),pairs(group/'cgroup.events')['populated'],baseline,pairs(group/'memory.events'))
        except Exception:reason='terminal-observation-changed'
    if reason!='compiler-fit-success':(group/'cgroup.kill').write_text('1')
    until=time.monotonic()+10
    while pairs(group/'cgroup.events')['populated'] and time.monotonic()<until:time.sleep(.1)
    empty=pairs(group/'cgroup.events')['populated']==0
    c.record(root/'collector.json',{**binding,'result':reason,'worker':terminal_unit,'workerStart':worker_start,'populated':0 if empty else 1,'eventsBefore':baseline,'eventsAfter':pairs(group/'memory.events'),'peak':peak,'observerGate':gate,'lastObservation':last,'elapsed':time.monotonic()-start})
if __name__=='__main__':
    import sys
    c.require(len(sys.argv)==2);collect(sys.argv[1])
