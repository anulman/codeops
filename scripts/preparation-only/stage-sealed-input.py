"""Future admitted copy/seal only; never enables fs-verity during source review."""
import os,stat,pathlib,hashlib,fcntl,struct

def need(ok):
    if not ok:raise ValueError('sealed staging refused')

def pin_source(path):
    parts=pathlib.Path(path).parts;need(parts[0]=='/' and all(x not in ('.','..') for x in parts))
    fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
    try:
        for i,name in enumerate(parts[1:]):
            st=os.fstat(fd);need(st.st_uid in (0,1000) and not st.st_mode&0o022)
            child=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|(os.O_DIRECTORY if i<len(parts)-2 else 0),dir_fd=fd)
            os.close(fd);fd=child
        st=os.fstat(fd);need(stat.S_ISREG(st.st_mode) and st.st_nlink==1 and st.st_uid in (0,1000) and st.st_size<=2*1024**3)
        return fd
    except BaseException:os.close(fd);raise

def stage(source,destination,expected):
    src=pin_source(source);before=os.fstat(src);h=hashlib.sha256()
    try:
        out=os.open(destination,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o400)
        try:
            remaining=before.st_size
            while remaining:
                b=os.read(src,min(1048576,remaining));need(b);remaining-=len(b);h.update(b)
                view=memoryview(b)
                while view:view=view[os.write(out,view):]
            need(h.hexdigest()==expected);os.fsync(out)
            after=os.fstat(src);need((before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)==(after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns))
        finally:os.close(out)
    finally:os.close(src)
    fd=os.open(destination,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        # struct fsverity_enable_arg, SHA256, 4096-byte Merkle blocks, no signature.
        arg=struct.pack('IIIIQIIQ',1,1,4096,0,0,0,0,0)+bytes(88)
        fcntl.ioctl(fd,0x40806685,arg)
        measure=bytearray(struct.pack('HH',0,64)+bytes(64));fcntl.ioctl(fd,0xc0046686,measure,True)
        algorithm,size=struct.unpack('HH',measure[:4]);need(algorithm==1 and size==32)
        with os.fdopen(os.dup(fd),'rb') as f:need(hashlib.file_digest(f,'sha256').hexdigest()==expected)
        st=os.fstat(fd);return {'sha256':expected,'veritySha256':bytes(measure[4:36]).hex(),'device':st.st_dev,'inode':st.st_ino,'bytes':st.st_size}
    finally:os.close(fd)
