"""Ownership-only transform of exact inventoried immutable plain tar inputs.
Bound extension allocation before tarfile parsing; do not admit new input hashes.
"""
import os,tarfile,pathlib

def require(ok):
    if not ok:raise ValueError('inventoried import refused')

def preflight(fd):
    size=os.fstat(fd.fileno()).st_size;require(size<=1024**3 and size%512==0)
    fd.seek(0);offset=0;count=0;metadata=0;zero=0
    while offset<size:
        h=fd.read(512);require(len(h)==512);offset+=512
        if h==bytes(512):
            zero+=1
            if zero==2:
                while offset<size:
                    b=fd.read(min(65536,size-offset));require(b and not b.strip(b'\0'));offset+=len(b)
                fd.seek(0);return
            continue
        require(zero==0);count+=1;require(count<=110000)
        raw=h[124:136].strip(b'\0 ');require(raw and all(c in b'01234567' for c in raw))
        n=int(raw,8);kind=h[156:157]
        chk=h[148:156].strip(b'\0 ');require(chk and all(c in b'01234567' for c in chk) and int(chk,8)==sum(h[:148])+256+sum(h[156:]))
        require(kind in (b'0',b'\0',b'2',b'5',b'x',b'g',b'L',b'K'))
        if kind in (b'x',b'g',b'L',b'K'):metadata+=n;require(n<=8192 and metadata<=1024**2)
        else:require(n<=128*1024**2)
        step=(n+511)//512*512;require(step<=size-offset);fd.seek(step,1);offset+=step
    raise ValueError('tar terminator missing')

def normalize(fd,destination):
    preflight(fd);count=0;total=0
    with open(destination,'xb') as output:
        with tarfile.open(fileobj=fd,mode='r:') as src,tarfile.open(fileobj=output,mode='w',format=tarfile.PAX_FORMAT) as dst:
            for m in src:
                count+=1;total+=m.size
                require(count<=100000 and total<=3*1024**3 and m.size<=128*1024**2)
                require(len(m.name.encode())<=4096 and len(m.linkname.encode())<=4096 and not m.sparse)
                require(m.isfile() or m.isdir() or m.issym())
                require(not m.name.startswith('/') and '..' not in pathlib.PurePosixPath(m.name).parts)
                m.uid=m.gid=1000;m.uname=m.gname='';m.mode &= 0o777;m.pax_headers={}
                if m.isfile():
                    with src.extractfile(m) as content:dst.addfile(m,content)
                else:dst.addfile(m)
                src.members.clear();dst.members.clear()
        output.flush();os.fsync(output.fileno())
    return destination
