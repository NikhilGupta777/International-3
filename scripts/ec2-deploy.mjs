#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { NodeSSH } from "node-ssh";

function getArg(name, fallback = "") {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

const host = getArg("host");
const keyPath = getArg("key");
const envPath = getArg("env");
const branch = getArg("branch", "main");
const repo = getArg(
  "repo",
  "https://github.com/NikhilGupta777/International-3.git",
);
const remoteDir = getArg("remote-dir", "/opt/ytgrabber");
const user = getArg("user", "ubuntu");
const localDir = getArg("local-dir", process.cwd());

if (!host || !keyPath || !envPath) {
  console.error(
    "Usage: node scripts/ec2-deploy.mjs --host=<ip> --key=<pem-path> --env=<env-file> [--branch=main] [--repo=url]",
  );
  process.exit(1);
}

const privateKey = readFileSync(keyPath, "utf8");
const ssh = new NodeSSH();

async function run(command, options = {}) {
  const res = await ssh.execCommand(command, options);
  if (res.code !== 0) {
    throw new Error(
      `Command failed (${res.code}): ${command}\nSTDOUT:\n${res.stdout}\nSTDERR:\n${res.stderr}`,
    );
  }
  if (res.stdout.trim()) process.stdout.write(`${res.stdout}\n`);
}

async function main() {
  await ssh.connect({
    host,
    username: user,
    privateKey,
    readyTimeout: 120000,
  });

  await run(`sudo mkdir -p ${remoteDir} && sudo chown -R ${user}:${user} ${remoteDir}`);

  await run(`sudo rm -rf ${remoteDir} && sudo mkdir -p ${remoteDir} && sudo chown -R ${user}:${user} ${remoteDir}`);

  const ok = await ssh.putDirectory(localDir, remoteDir, {
    recursive: true,
    concurrency: 8,
    validate: (localPath) => {
      const normalized = localPath.replaceAll("\\", "/");
      const blocked = [
        "/.git/",
        "/node_modules/",
        "/.venv/",
        "/.playwright-cli/",
        "/scratch/",
        "/screenshots/",
        "/dist/",
      ];
      return !blocked.some((marker) => normalized.includes(marker));
    },
  });
  if (!ok) {
    throw new Error("Directory upload failed.");
  }

  await ssh.putFile(envPath, `${remoteDir}/.env`);

  await run(
    `
set -euo pipefail
cd "${remoteDir}"
sudo docker compose -f docker-compose.yml -f deploy/ec2/docker-compose.prod.yml build --pull
sudo docker compose -f docker-compose.yml -f deploy/ec2/docker-compose.prod.yml up -d
sudo docker compose -f docker-compose.yml -f deploy/ec2/docker-compose.prod.yml ps
`.trim(),
    { cwd: "/" },
  );

  await run(`curl -fsS http://127.0.0.1/api/healthz || true`, { cwd: "/" });
  ssh.dispose();
}

main().catch((err) => {
  console.error(err.message || String(err));
  process.exit(1);
});
