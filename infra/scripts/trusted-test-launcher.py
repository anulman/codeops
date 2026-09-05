#!/usr/bin/python3
"""Trusted operator launcher. Review/install outside the checkout before use.
No caller DB URL, Docker options, environment forwarding, bind mounts, or ports.
"""
import argparse, hashlib, io, json, os, pathlib, subprocess, tarfile, tempfile, time, uuid

ENV = {"PATH": "/usr/bin:/bin", "HOME": "/nonexistent"}
PG_IMAGE = "sha256:67f41722b7a8cbdb868a44a4995c846eddfdc2973bccb291ce937dce88ad5675"
ROOT = pathlib.Path(__file__).resolve().parent

def call(args, *, data=None, capture=True, check=True):
    return subprocess.run(args, input=data, stdout=subprocess.PIPE if capture else None,
                          stderr=subprocess.PIPE if capture else None, env=ENV, check=check, timeout=2700)

def docker(*args, **kwargs):
    return call(["/usr/bin/docker", *args], **kwargs)

def inspect(name):
    return json.loads(docker("inspect", name).stdout)[0]

def enforce(condition):
    if not condition:
        raise RuntimeError("Disposable execution boundary refused")

def assert_boundary(db, run_id):
    spec = inspect(db)
    enforce(spec["Config"]["Labels"] == {"codeops.disposable-run": run_id})
    enforce(spec["Image"] == PG_IMAGE)
    enforce(spec["HostConfig"]["NetworkMode"] == "none")
    enforce(not spec["HostConfig"].get("Binds"))
    enforce(not spec["HostConfig"].get("PortBindings"))
    enforce(not spec["HostConfig"].get("Privileged"))
    enforce(spec["HostConfig"]["CapDrop"] == ["ALL"])
    enforce(spec["Config"]["User"] == "999:999")
    enforce(spec["HostConfig"]["ReadonlyRootfs"])
    enforce(all(m["Type"] == "tmpfs" for m in spec["Mounts"]))
    if not spec["State"]["Running"]:
        print(docker("logs", db, check=False).stdout.decode(), flush=True)
        raise RuntimeError("Disposable PostgreSQL did not start")
    result = docker("exec", db, "psql", "-U", "postgres", "-d", "codeops_disposable_test", "-Atc",
                    "SELECT current_database() || ':' || current_setting('codeops.disposable_run') || ':' || "
                    "(SELECT system_identifier FROM pg_control_system())::text").stdout.decode().strip()
    enforce(result.startswith("codeops_disposable_test:" + run_id + ":"))
    return result.rsplit(":", 1)[1]

def snapshot(source, dest):
    paths = call(["/usr/bin/git", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", str(source), "ls-files", "-z", "--cached", "--others", "--exclude-standard"]).stdout.split(b"\0")
    digest = hashlib.sha256()
    with tarfile.open(dest, "w") as archive:
        root = tarfile.TarInfo("."); root.type = tarfile.DIRTYPE
        root.mode = 0o755; root.uid = root.gid = 1000; archive.addfile(root)
        scratch = tarfile.TarInfo(".tmp"); scratch.type = tarfile.DIRTYPE
        scratch.mode = 0o700; scratch.uid = scratch.gid = 1000; archive.addfile(scratch)
        directories = {".tmp"}
        for raw in sorted(set(paths)):
            if not raw: continue
            rel = pathlib.Path(os.fsdecode(raw))
            if any(x in (".git", "node_modules") or (x == ".env" or x.startswith(".env.")) for x in rel.parts): continue
            path = source / rel
            if not path.exists(): continue
            if path.is_symlink() or not path.is_file():
                raise RuntimeError("Source snapshot rejects symlinks and special files")
            for parent in reversed(rel.parents):
                if str(parent) == "." or str(parent) in directories: continue
                directory = tarfile.TarInfo(str(parent)); directory.type = tarfile.DIRTYPE
                directory.mode = 0o755; directory.uid = directory.gid = 1000
                archive.addfile(directory); directories.add(str(parent))
            content = path.read_bytes()
            digest.update(raw + b"\0" + content)
            entry = tarfile.TarInfo(str(rel)); entry.size = len(content)
            entry.mode = 0o755 if os.access(path, os.X_OK) else 0o644
            entry.uid = entry.gid = 1000
            archive.addfile(entry, io.BytesIO(content))
    return digest.hexdigest()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=pathlib.Path)
    parser.add_argument("--gate", choices=["proof", "focused", "verify"], default="proof")
    parser.add_argument("--dependencies", type=pathlib.Path, required=True,
                        help="Operator-reviewed dependency-only cache source, never mounted in runtime")
    args = parser.parse_args()
    config = json.loads((ROOT / "launcher-config.json").read_text())
    image = config["runnerImage"]
    enforce(image.startswith("sha256:") and len(image) == 71)
    run_id = str(uuid.uuid4()); db = "codeops-test-db-" + run_id; runner = "codeops-test-run-" + run_id
    volume = "codeops-test-work-" + run_id
    source = args.source.resolve()
    with tempfile.TemporaryDirectory(prefix="codeops-test-source-") as temp:
        archive = pathlib.Path(temp) / "source.tar"
        source_digest = snapshot(source, archive)
        try:
            docker("volume", "create", "--label", "codeops.disposable-run=" + run_id, volume)
            docker("run", "-d", "--name", db, "--label", "codeops.disposable-run=" + run_id,
                   "--network", "none", "--read-only", "--tmpfs", "/var/lib/postgresql/data:rw,noexec,nosuid,size=1g,uid=999,gid=999,mode=0700",
                   "--tmpfs", "/var/run/postgresql:rw,noexec,nosuid,uid=999,gid=999,mode=0770", "--tmpfs", "/tmp:rw,noexec,nosuid",
                   "--security-opt", "no-new-privileges", "--cap-drop", "ALL", "--user", "999:999",
                   "--memory", "1536m", "--pids-limit", "128", "-e", "POSTGRES_HOST_AUTH_METHOD=trust",
                   "-e", "POSTGRES_DB=codeops_disposable_test", PG_IMAGE,
                   "postgres", "-c", "listen_addresses=127.0.0.1", "-c", "codeops.disposable_run=" + run_id)
            for _ in range(60):
                ready = docker("exec", db, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "codeops_disposable_test", check=False)
                if ready.returncode == 0: break
                time.sleep(0.25)
            identity = assert_boundary(db, run_id)
            docker("create", "--name", runner, "--network", "container:" + db,
                   "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
                   "--user", "1000:1000", "--memory", "6g", "--pids-limit", "512",
                   "--tmpfs", "/tmp:rw,nosuid,size=2g,mode=1777", "--mount", "type=volume,src=" + volume + ",dst=/work",
                   "--workdir", "/work", "--entrypoint", "/usr/bin/env", image,
                   "-i", "PATH=/opt/nub/bin:/usr/local/bin:/usr/bin:/bin", "HOME=/tmp/home", "TMPDIR=/work/.tmp", "CI=true", "CODEOPS_OFFLINE_CHARTS=1",
                   "CODEOPS_TEST_POSTGRES_URL=postgresql://postgres@127.0.0.1:5432/codeops_disposable_test",
                   "CODEOPS_DISPOSABLE_RUN=" + run_id, "CODEOPS_DISPOSABLE_SYSTEM_ID=" + identity,
                   "sleep", "infinity")
            docker("cp", "-a", "-", runner + ":/work", data=archive.read_bytes())
            # Only dependency directories; no home, config, .git or source execution on host.
            dep = args.dependencies.resolve()
            dependency_paths = ["node_modules", "infra/charts/codeops/charts"]
            for group in ("packages", "services", "sites"):
                dependency_paths.extend(str(p.relative_to(dep)) for p in (dep / group).glob("*/node_modules"))
            # One archive root keeps workspace-relative dependency symlinks inside /work.
            producer = subprocess.Popen(["/usr/bin/tar", "-cf", "-", "-C", str(dep), *dependency_paths],
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=ENV)
            consumer = subprocess.run(["/usr/bin/docker", "cp", "-a", "-", runner + ":/work"],
                                      stdin=producer.stdout, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=ENV)
            producer.stdout.close()
            producer.wait()
            if producer.returncode or consumer.returncode:
                raise RuntimeError("Dependency-only archive copy failed")
            docker("start", runner)
            docker("exec", runner, "/bin/mkdir", "-p", "/work/.tmp", "/tmp/home")
            spec = inspect(runner)
            enforce(spec["HostConfig"]["NetworkMode"] == "container:" + inspect(db)["Id"])
            enforce(not spec["HostConfig"].get("Binds") and not spec["HostConfig"].get("PortBindings"))
            enforce(spec["HostConfig"]["CapDrop"] == ["ALL"])
            enforce(spec["Config"]["User"] == "1000:1000")
            enforce(spec["HostConfig"]["ReadonlyRootfs"])
            enforce(len(spec["Mounts"]) == 1 and spec["Mounts"][0]["Name"] == volume)
            assert_boundary(db, run_id)
            print(json.dumps({"event":"isolation_verified", "run":run_id, "sourceDigest":source_digest,
                              "postgresImage":PG_IMAGE,"runnerImage":image,"systemIdentifier":identity,
                              "network":"loopback-only", "productionCredentials":False}), flush=True)
            environment = ["/usr/bin/env", "-i", "PATH=/opt/nub/bin:/usr/local/bin:/usr/bin:/bin", "HOME=/tmp/home", "TMPDIR=/work/.tmp", "CI=true", "CODEOPS_OFFLINE_CHARTS=1",
                           "CODEOPS_TEST_POSTGRES_URL=postgresql://postgres@127.0.0.1:5432/codeops_disposable_test",
                           "CODEOPS_DISPOSABLE_RUN=" + run_id, "CODEOPS_DISPOSABLE_SYSTEM_ID=" + identity]
            commands = {
                "proof": ["node", "infra/scripts/prove-disposable-postgres.mjs"],
                "focused": ["/bin/sh", "-c", "nub run --filter @codeops/codeops-contracts build && nub run --filter @codeops/codeops-control-gateway build && node --test services/codeops-control-gateway/test/database-authority-postgres.test.mjs services/codeops-control-gateway/test/runtime-binding-postgres.test.mjs services/codeops-control-gateway/test/work-item-admission-postgres.test.mjs services/codeops-control-gateway/test/github-branch-publish-candidates-postgres.test.mjs && node infra/scripts/prepare-codeops-chart-dependencies.mjs && node --test infra/scripts/test-codeops-chart.mjs"],
                "verify": ["nub", "run", "verify"],
            }
            if args.gate != "proof":
                docker("exec", runner, *environment, *commands["proof"], capture=False)
            result = docker("exec", runner, *environment, *commands[args.gate], capture=False, check=False)
            print(json.dumps({"event":"gate_finished","gate":args.gate,"exitCode":result.returncode,"run":run_id}), flush=True)
            return result.returncode
        finally:
            # Names are fresh UUIDs generated here. Never touch incident volumes or containers.
            docker("rm", "-f", runner, db, check=False)
            docker("volume", "rm", volume, check=False)

if __name__ == "__main__":
    try: raise SystemExit(main())
    except subprocess.CalledProcessError as error:
        print((error.stderr or b"deployment-free subprocess failure").decode(), flush=True)
        raise SystemExit("Trusted launcher failed")
