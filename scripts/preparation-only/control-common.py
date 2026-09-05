"""Source-only trusted control primitives. No shell or caller command strings."""
import os,stat,json,hashlib,subprocess,selectors,time,signal,pathlib

def require(ok):
    if not ok: raise ValueError('resource boundary refused')

def protected(path,directory=False):
    p=pathlib.Path(path);require(p.is_absolute() and '..' not in p.parts)
    fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
    try:
        for i,part in enumerate(p.parts[1:]):
            s=os.fstat(fd);require(s.st_uid==0 and not s.st_mode&0o022)
            child=os.open(part,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|(os.O_DIRECTORY if i<len(p.parts)-2 or directory else 0),dir_fd=fd)
            os.close(fd);fd=child
        s=os.fstat(fd);require(s.st_uid==0 and not s.st_mode&0o022)
        require(stat.S_ISDIR(s.st_mode) if directory else stat.S_ISREG(s.st_mode))
        return fd
    except BaseException:os.close(fd);raise

def json_fd(fd,cap=1024*1024):
    require(os.fstat(fd).st_size<=cap);os.lseek(fd,0,0)
    with os.fdopen(os.dup(fd),'rb') as f:return json.load(f)

def record(path,data):
    b=json.dumps(data,sort_keys=True).encode();require(len(b)<=1024*1024)
    path=pathlib.Path(path);tmp=path.with_name(path.name+'.partial')
    fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o400)
    try:
        with os.fdopen(fd,'wb',closefd=False) as f:f.write(b);f.flush();os.fsync(fd)
        # link is atomic/no-overwrite; both names retained as run-owned evidence.
        os.link(tmp,path,follow_symlinks=False)
    finally:os.close(fd)
    d=os.open(str(path.parent),os.O_RDONLY|os.O_DIRECTORY)
    try:os.fsync(d)
    finally:os.close(d)

def command(argv,timeout=60,cap=1024*1024,stdin=None):
    # Only trusted fixed callers; each executable must be admitted in tool manifest.
    env={'PATH':'/runtime/docker:/runtime/python/bin','HOME':'/nonexistent','TMPDIR':'/state/tmp','LANG':'C'}
    if isinstance(argv[0],list):
        env['MKE2FS_CONFIG']=str(pathlib.Path(argv[0][0]).parents[3]/'etc/mke2fs.conf')
        argv=[*argv[0],*argv[1:]]
    p=subprocess.Popen(argv,stdin=stdin or subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env,close_fds=True,start_new_session=True)
    sel=selectors.DefaultSelector();buf=bytearray();deadline=time.monotonic()+timeout
    for f in (p.stdout,p.stderr):os.set_blocking(f.fileno(),False);sel.register(f,selectors.EVENT_READ)
    try:
        while sel.get_map():
            require(time.monotonic()<deadline)
            for key,_ in sel.select(.1):
                b=os.read(key.fd,65536)
                if not b:sel.unregister(key.fileobj);continue
                require(len(buf)+len(b)<=cap);buf.extend(b)
        require(p.wait(timeout=max(.01,deadline-time.monotonic()))==0)
        return bytes(buf)
    finally:
        if p.poll() is None:os.killpg(p.pid,signal.SIGKILL)
        p.wait();sel.close();p.stdout.close();p.stderr.close()


def wait_ack(path,alive,timeout=30):
    """Worker-side bounded gate: absent/lost collector can never permit progress."""
    require(0<timeout<=30);deadline=time.monotonic()+timeout;path=pathlib.Path(path)
    while not path.exists():
        require(time.monotonic()<deadline and alive());time.sleep(min(.1,timeout))
    require(alive())
    fd=protected(path)
    try:return json_fd(fd)
    finally:os.close(fd)
