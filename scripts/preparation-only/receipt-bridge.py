"""Fixed root evidence bridge. No caller source paths, recursive copies, or cleanup."""
import os,stat,pathlib,json,hashlib,sys
B=pathlib.Path('/opt/codeops-preparation');CAP=1024*1024;TOTAL=8*CAP
NAMES=('intent.json','allocation.json','loop.json','mount.json','preparation-receipt.json','clean-input-bindings.json')
def need(v):
    if not v:raise ValueError('receipt bridge refused')
def read_at(fd,n,device):
    try:f=os.open(n,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
    except FileNotFoundError:return None
    try:
        s=os.fstat(f);need(stat.S_ISREG(s.st_mode) and s.st_uid==0 and s.st_gid==0 and stat.S_IMODE(s.st_mode)==0o400 and s.st_dev==device and s.st_size<=CAP)
        b=b''
        while len(b)<=CAP:
            part=os.read(f,min(65536,CAP+1-len(b)))
            if not part:break
            b+=part
        need(len(b)==s.st_size);end=os.fstat(f);need((s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns)==(end.st_ino,end.st_size,end.st_mtime_ns,end.st_ctime_ns))
        return b,{'device':s.st_dev,'inode':s.st_ino,'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest(),'mode':stat.S_IMODE(s.st_mode),'uid':s.st_uid,'gid':s.st_gid}
    finally:os.close(f)
def put(root,n,b):
    f=os.open(root/n,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o444)
    with os.fdopen(f,'wb') as out:out.write(b);out.flush();os.fsync(out.fileno())
def finalize_transport(root):
    # Construction remains private under inherited umask 077. Only the fixed
    # transport copy becomes readable; originals/ancestors are never chmodded.
    allowed=set(NAMES)|{n+'.partial' for n in NAMES}|{'context.json','runtime-readback.json','admission.json','terminal.json','bridge.json'}
    names=os.listdir(root);need(len(names)<=17 and set(names)<=allowed)
    fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        st=os.fstat(fd);need(st.st_uid==0 and st.st_gid==0 and not st.st_mode&0o022)
        for n in names:
            f=os.open(n,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
            try:
                st=os.fstat(f);need(stat.S_ISREG(st.st_mode) and st.st_uid==0 and st.st_gid==0 and st.st_nlink==1 and st.st_size<=CAP)
                os.fchmod(f,0o444);os.fsync(f)
            finally:os.close(f)
        # Directory becomes traversable only after all copies are finalized.
        os.fchmod(fd,0o555);os.fsync(fd)
    finally:os.close(fd)
def main():
    need(os.geteuid()==0 and len(sys.argv)==1)
    # Fixed /opt ancestors only; no caller path selection.
    fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
    for part in ('opt','codeops-preparation'):
        s=os.fstat(fd);need(s.st_uid==0 and not s.st_mode&0o022)
        nf=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd);os.close(fd);fd=nf
    st=os.fstat(fd);need(st.st_uid==0 and not st.st_mode&0o022)
    out=B/'transport';out.mkdir(mode=0o700);data={};total=0
    context_result=read_at(fd,'context.json',st.st_dev)
    context=json.loads(context_result[0]) if context_result else None
    if context:need(context['bootId']==pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip())
    for n in ('context.json','runtime-readback.json','admission.json','terminal.json'):
        item=read_at(fd,n,st.st_dev)
        if item:
            b,meta=item;total+=len(b);need(total<=TOTAL);put(out,n,b);data[n]=meta
    incomplete=[];leftovers={}
    if context:
        import uuid
        run=str(uuid.UUID(context['runId']));need(context['runRoot']==str(B/'runs'/run))
        runs=os.open('runs',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
        need(os.fstat(runs).st_uid==0 and not os.fstat(runs).st_mode&0o022)
        root=os.open(run,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=runs);os.close(runs)
        try:
            rs=os.fstat(root);need([rs.st_dev,rs.st_ino]==context['rootIdentity'] and rs.st_uid==0 and not rs.st_mode&0o022)
            for n in NAMES:
                for suffix in ('','.partial'):
                    item=read_at(root,n+suffix,rs.st_dev)
                    if item:
                        b,meta=item;total+=len(b);need(total<=TOTAL);put(out,n+suffix,b);data[n+suffix]=meta
                    elif suffix=='':incomplete.append(n)
            for n in ('disk.img','state','lock'):
                try:
                    s=os.stat(n,dir_fd=root,follow_symlinks=False)
                    leftovers[n]={'device':s.st_dev,'inode':s.st_ino,'mode':s.st_mode,'bytes':s.st_size,'blocks':s.st_blocks,'uid':s.st_uid}
                except FileNotFoundError:pass
        finally:os.close(root)
    terminal=json.loads((out/'terminal.json').read_bytes()) if (out/'terminal.json').exists() else {}
    complete=context is not None and not incomplete and terminal.get('exit')==0
    if complete:
        receipt=json.loads((out/'preparation-receipt.json').read_bytes())
        binding=json.loads((out/'clean-input-bindings.json').read_bytes())
        for document in (receipt,binding):
            need(isinstance(document,dict))
            need(all(document.get(k)==context[k] for k in ('runId','bootId','packetSha256')))
            need(document.get('decision')=='NOT_ADMITTED' and document.get('executionAdmitted') is False)
    summary={'context':context,'files':data,'missing':incomplete,'preparationCompleted':complete,'executionAdmitted':False,'exportAdmitted':False,'leftovers':leftovers,'originalsPreserved':True,'externalRunAuthenticationRequired':True}
    put(out,'bridge.json',json.dumps(summary,sort_keys=True).encode());finalize_transport(out);os.close(fd)
if __name__=='__main__':main()
