import { type ChildProcess, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as net from "net";

export interface OrielServer {
  url: string;
  port: number;
  token: string;
  stateDbPath: string;
  logs: string[];
  stop: () => Promise<void>;
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        reject(new Error("Could not get free port"));
      }
    });
  });
}

export async function startOriel(opts?: {
  stateDbPath?: string;
}): Promise<OrielServer> {
  const stateDbPath =
    opts?.stateDbPath ??
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), "oriel-test-")), "state.db");

  const port = await getFreePort();
  const addr = `127.0.0.1:${port}`;

  const binPath = path.resolve(__dirname, "../../../bin/oriel");
  if (!fs.existsSync(binPath)) {
    throw new Error(`Oriel binary not found at ${binPath}. Run 'make build' first.`);
  }

  let token = "";
  const logs: string[] = [];

  // Start from project root so Claude uses the correct CWD for session/history lookup
  const projectRoot = path.resolve(__dirname, "../../..");

  const proc: ChildProcess = spawn(binPath, [
    "-listen-addr", addr,
    "-state-db", stateDbPath,
    "-no-open",
    "-log-level", "debug",
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: projectRoot,
    env: { ...process.env },
  });

  const tokenPromise = new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Oriel did not start within 15s")), 15_000);

    const onData = (data: Buffer) => {
      const line = data.toString();
      logs.push(line);
      const match = line.match(/token=([a-f0-9]+)/);
      if (match) {
        token = match[1];
        clearTimeout(timeout);
        resolve(token);
      }
    };
    proc.stderr?.on("data", onData);
    proc.stdout?.on("data", onData);
    proc.on("error", (err) => { clearTimeout(timeout); reject(err); });
    proc.on("exit", (code) => {
      if (!token) { clearTimeout(timeout); reject(new Error(`Oriel exited with code ${code}`)); }
    });
  });

  token = await tokenPromise;
  const url = `http://${addr}/?token=${token}`;

  return {
    url,
    port,
    token,
    stateDbPath,
    logs,
    stop: async () => {
      if (proc.exitCode === null) {
        proc.kill("SIGTERM");
        await new Promise<void>((resolve) => {
          const t = setTimeout(() => { proc.kill("SIGKILL"); resolve(); }, 5000);
          proc.on("exit", () => { clearTimeout(t); resolve(); });
        });
      }
    },
  };
}
