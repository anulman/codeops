"""Future admitted preparation only. Proposed clean-input 16 GiB fully allocated backing, no cleanup."""
import os,pathlib,json,hashlib,importlib.util
s=importlib.util.spec_from_file_location('common',pathlib.Path(__file__).with_name('control-common.py'));c=importlib.util.module_from_spec(s);s.loader.exec_module(c)
SIZE=16*1024**3

def prepare(root,tools,backing_policy):
    root=pathlib.Path(root);fd=c.protected(root,True);os.close(fd)
    c.require(backing_policy in ('separate-device-fixed-v1','same-backing-fixed-v1'))
    if backing_policy=='separate-device-fixed-v1':c.require(root.stat().st_dev!=pathlib.Path('/').stat().st_dev)
    fs=os.statvfs(root);c.require(fs.f_bavail*fs.f_frsize>=SIZE+16*1024**3 and fs.f_favail>=262144)
    # Files remain run-owned evidence on any failure. Never detach unknown loops.
    backing=root/'disk.img';mount=root/'state';mount.mkdir(mode=0o700)
    f=os.open(backing,os.O_RDWR|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    try:
        os.posix_fallocate(f,0,SIZE);os.fsync(f);st=os.fstat(f)
        c.require(st.st_size==SIZE and st.st_blocks*512>=SIZE)
        post=os.statvfs(root);c.require(post.f_bavail*post.f_frsize>=16*1024**3 and post.f_favail>=262144)
        c.record(root/'allocation.json',{'device':st.st_dev,'inode':st.st_ino,'bytes':SIZE,'allocated':st.st_blocks*512})
    finally:os.close(f)
    loop=c.command([tools['losetup'],'--find','--show','--nooverlap',str(backing)]).decode().strip()
    c.require(loop.startswith('/dev/loop') and loop[9:].isdigit())
    c.record(root/'loop.json',{'loop':loop,'backing':str(backing),'device':st.st_dev,'inode':st.st_ino})
    c.command([tools['mkfs.ext4'],'-t','ext4','-F','-O','verity','-N','220000','-E','lazy_itable_init=0,lazy_journal_init=0',loop],timeout=120)
    c.command([tools['mount'],'-t','ext4','-o','nodev,nosuid',loop,str(mount)])
    lines=pathlib.Path('/proc/self/mountinfo').read_text().splitlines()
    matches=[line.split() for line in lines if line.split()[4]==str(mount)]
    c.require(len(matches)==1);entry=matches[0];sep=entry.index('-')
    c.require(entry[sep+1]=='ext4' and entry[sep+2]==loop)
    c.require({'rw','nodev','nosuid'}<=set(entry[5].split(',')))
    loopst=os.stat(loop);c.require(entry[2]==str(os.major(loopst.st_rdev))+':'+str(os.minor(loopst.st_rdev)))
    mounted=os.statvfs(mount);c.require(mount.stat().st_dev!=root.stat().st_dev)
    c.require(mounted.f_blocks*mounted.f_frsize<=SIZE and mounted.f_files>=200000)
    for name in ['docker','exec','tmp','work','raw','output','journal','logs']: (mount/name).mkdir(mode=0o700)
    c.record(root/'mount.json',{'mount':str(mount),'device':mount.stat().st_dev,'inode':mount.stat().st_ino,'mountinfo':pathlib.Path('/proc/self/mountinfo').read_text()[-65536:]})
    return mount
