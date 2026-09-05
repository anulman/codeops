"""Unexecuted exact-tree readback. No links followed during enumeration."""
import os,stat,pathlib,hashlib,json,importlib.util
s=importlib.util.spec_from_file_location('c',pathlib.Path(__file__).with_name('control-common.py'));c=importlib.util.module_from_spec(s);s.loader.exec_module(c)
def digest(x):return hashlib.sha256(json.dumps(x,sort_keys=True,separators=(',',':')).encode()).hexdigest()
def expected(plan,packet):
    tree={}
    for name,item in plan['members'].items():
        tree[name]={'type':'link','link':item['link'],'mode':511,'uid':0,'gid':0} if 'link' in item else {'type':'file','sha256':item['sha256'],'mode':item['mode']&0o555,'uid':0,'gid':0}
    for name,h in packet['files'].items():
        if name.endswith('.py'):tree['packet/'+name]={'type':'file','sha256':h,'mode':0o444,'uid':0,'gid':0}
    for name in ['dev','proc','sys/fs/cgroup','state','inputs','etc','run','tmp','packet']:
        tree.setdefault(name,{'type':'dir','mode':0o755,'uid':0,'gid':0})
    for name in list(tree):
        for parent in pathlib.PurePosixPath(name).parents:
            if str(parent)!='.':tree.setdefault(str(parent),{'type':'dir','mode':0o755,'uid':0,'gid':0})
    return tree

def resolve(tree,name):
    pending=name.split('/');current=[];hops=0
    while pending:
        part=pending.pop(0)
        if current:c.require(tree['/'.join(current)]['type']=='dir')
        if part in ('','.'):continue
        if part=='..':c.require(current);current.pop();continue
        key='/'.join(current+[part]);c.require(key in tree);node=tree[key]
        if node['type']=='link':
            hops+=1;c.require(hops<=40 and not node['link'].startswith('/'));pending=node['link'].split('/')+pending
        else:current.append(part)
    return '/'.join(current)

def verify(root,tree):
    root=pathlib.Path(root);fd=c.protected(root,True);os.close(fd);actual={}
    for base,dirs,files in os.walk(root,followlinks=False):
        for name in dirs+files:
            p=pathlib.Path(base)/name;rel=str(p.relative_to(root));st=p.lstat();node={'mode':stat.S_IMODE(st.st_mode),'uid':st.st_uid,'gid':st.st_gid}
            if stat.S_ISLNK(st.st_mode):node.update(type='link',link=os.readlink(p))
            elif stat.S_ISDIR(st.st_mode):node.update(type='dir')
            else:
                c.require(stat.S_ISREG(st.st_mode));f=c.protected(p)
                with os.fdopen(f,'rb') as stream:node.update(type='file',sha256=hashlib.file_digest(stream,'sha256').hexdigest())
            actual[rel]=node;c.require(len(actual)<=20000)
    c.require(actual==tree)
    links={n:resolve(tree,n) for n,x in tree.items() if x['type']=='link'}
    return {'treeSha256':digest(actual),'links':links,'entries':len(actual)}

def bootstrap(contract):
    # Hosted operator must independently bind this contract, not use old local hashes.
    c.require(contract['decision']=='exact-host-bootstrap-admitted')
    proof=verify(contract['root'],contract['tree'])
    c.require(proof['treeSha256']==contract['treeSha256'])
    c.require(dict(os.environ)==contract['environment'])
    c.require(set(contract['environment'])=={'PATH','LANG','HOME','TMPDIR'})
    c.require(contract['environment']['LANG']=='C' and contract['environment']['HOME']=='/nonexistent')
    for directory in contract['environment']['PATH'].split(':'):
        path=pathlib.Path(directory);c.require(path.is_relative_to(contract['root']))
        fd=c.protected(path,True);os.close(fd)
    c.require(set(contract['helperRoles'])=={'dpkg-deb','gzip','xz','zstd'})
    c.require(all(rel in contract['helperExecutables'] for rel in contract['helperRoles'].values()))
    exe=pathlib.Path('/proc/self/exe').resolve();c.require(str(exe)==contract['interpreter'])
    mapped=set()
    for line in pathlib.Path('/proc/self/maps').read_text().splitlines():
        fields=line.split()
        if len(fields)>=6 and fields[-1].startswith('/') and 'x' in fields[1]:mapped.add(fields[-1])
    c.require(mapped==set(contract['executableMappings']))
    for path,h in contract['executableMappings'].items():
        fd=c.protected(path)
        with os.fdopen(fd,'rb') as f:c.require(hashlib.file_digest(f,'sha256').hexdigest()==h)
    c.require(all(str(pathlib.Path(contract['root'])/resolve(contract['tree'],rel))==path for rel,path in contract['helperExecutables'].items()))
    return proof
