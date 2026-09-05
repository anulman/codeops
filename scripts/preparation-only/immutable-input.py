"""Review-only fs-verity protected input adapter; no readonly-bind equivalence claim.
Requires independently pinned fs-verity SHA256 measurement AND content SHA256.
Does not enable verity, write inputs, or accept caller-writable ancestors.
"""
import os,stat,fcntl,struct,hashlib,contextlib
MEASURE=0xc0046686

def need(ok):
    if not ok:raise ValueError('immutable input refused')

@contextlib.contextmanager
def open_verified(path,content_sha256,verity_sha256,max_bytes):
    need(os.path.isabs(path));parts=path.split('/')[1:]
    need(parts and all(p not in ('','.','..') for p in parts))
    current=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
    fd=None
    try:
        for name in parts[:-1]:
            s=os.fstat(current);need(s.st_uid==0 and not s.st_mode&0o022)
            child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=current)
            os.close(current);current=child
        s=os.fstat(current);need(s.st_uid==0 and not s.st_mode&0o022)
        fd=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=current)
        before=os.fstat(fd)
        need(stat.S_ISREG(before.st_mode) and before.st_uid==0 and not before.st_mode&0o222 and before.st_size<=max_bytes)
        digest=bytearray(struct.pack('HH',0,64)+bytes(64));fcntl.ioctl(fd,MEASURE,digest,True)
        algorithm,size=struct.unpack('HH',digest[:4]);need(algorithm==1 and size==32)
        need(bytes(digest[4:36]).hex()==verity_sha256)
        with os.fdopen(os.dup(fd),'rb') as stream:
            need(hashlib.file_digest(stream,'sha256').hexdigest()==content_sha256);stream.seek(0)
            yield stream
            after=os.fstat(fd)
            need((before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)==(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns))
    finally:
        if fd is not None:os.close(fd)
        os.close(current)
