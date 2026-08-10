/**
 * The SSH transport. The only file in the SSH path that opens a socket.
 *
 * Feasibility was established empirically before this existed: `ssh2` runs
 * under Deno through `node:net` and `node:crypto`, provided the cipher list is
 * pinned to CTR modes. Deno's `node:crypto` cannot drive AES-GCM the way
 * `ssh2` needs, so GCM is excluded in `SSH_ALGORITHMS` rather than left to
 * negotiation. A handshake, a host-key fingerprint identical to
 * `ssh-keygen -lf`, public-key auth and a real `exec` with an exit code were
 * all confirmed against a live sshd before any of this was wired up.
 *
 * The interface is separated from the implementation so the safety model can
 * be tested without a network.
 */

import {
  SSH_ALGORITHMS,
  SSH_CONNECT_TIMEOUT_MS,
  WP_CLI_MAX_OUTPUT_BYTES,
} from "./sshSafety.ts";

export type SshTarget = {
  host: string;
  port: number;
  username: string;
  privateKey: string;
  passphrase?: string;
};

/**
 * The slice of the ssh2 exec stream this file uses. Narrower than the library's
 * own type so the transport can't quietly grow new capabilities.
 */
type SshExecStream = {
  on(event: "data", listener: (chunk: Buffer) => void): SshExecStream;
  on(event: "close", listener: (code: number | null) => void): SshExecStream;
  stderr: { on(event: "data", listener: (chunk: Buffer) => void): unknown };
};

export type SshExecOutcome =
  | {
      ok: true;
      exitCode: number;
      stdout: string;
      stderr: string;
      fingerprint: string;
      durationMs: number;
      outputTruncated: boolean;
    }
  | {
      ok: false;
      kind: "auth_failed" | "unreachable" | "timeout" | "host_key_rejected" | "protocol_error";
      fingerprint: string | null;
      detail: string;
    };

export type SshTransport = {
  /**
   * Runs one already-validated command. `acceptHostKey` receives the server's
   * SHA256 fingerprint and decides — the transport never trusts a key itself.
   */
  exec: (
    target: SshTarget,
    command: string,
    timeoutMs: number,
    acceptHostKey: (fingerprint: string) => boolean,
  ) => Promise<SshExecOutcome>;
};

/** Reads at most `limit` characters, then keeps draining without storing. */
const boundedCollector = (limit: number) => {
  let text = "";
  let truncated = false;
  return {
    push(chunk: unknown) {
      if (text.length >= limit) {
        truncated = true;
        return;
      }
      const value = String(chunk);
      const room = limit - text.length;
      if (value.length > room) {
        text += value.slice(0, room);
        truncated = true;
      } else {
        text += value;
      }
    },
    get value() {
      return text;
    },
    get truncated() {
      return truncated;
    },
  };
};

export const denoSshTransport = (): SshTransport => ({
  async exec(target, command, timeoutMs, acceptHostKey) {
    const startedAt = Date.now();
    // Imported lazily so the pure safety modules stay runtime-agnostic.
    const { Client } = await import("npm:ssh2@1.16.0");
    const { createHash } = await import("node:crypto");

    const client = new Client();
    let presented: string | null = null;
    let settled = false;

    return await new Promise<SshExecOutcome>((resolve) => {
      const finish = (outcome: SshExecOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        try {
          client.end();
        } catch {
          // The connection is already gone; nothing to unwind.
        }
        resolve(outcome);
      };

      const deadline = setTimeout(() => {
        finish({
          ok: false,
          kind: "timeout",
          fingerprint: presented,
          detail: "The server did not finish the inspection in time.",
        });
      }, timeoutMs + SSH_CONNECT_TIMEOUT_MS);

      client.on("ready", () => {
        client.exec(command, (error: Error | undefined, stream: any) => {
          if (error || !stream) {
            finish({
              ok: false,
              kind: "protocol_error",
              fingerprint: presented,
              detail: "The server accepted the connection but refused to run the inspection.",
            });
            return;
          }

          const stdout = boundedCollector(WP_CLI_MAX_OUTPUT_BYTES);
          const stderr = boundedCollector(WP_CLI_MAX_OUTPUT_BYTES);

          stream.on("data", (chunk: unknown) => stdout.push(chunk));
          stream.stderr.on("data", (chunk: unknown) => stderr.push(chunk));
          stream.on("close", (code: number | null) => {
            finish({
              ok: true,
              exitCode: typeof code === "number" ? code : -1,
              stdout: stdout.value,
              stderr: stderr.value,
              fingerprint: presented ?? "",
              durationMs: Date.now() - startedAt,
              outputTruncated: stdout.truncated || stderr.truncated,
            });
          });
        });
      });

      client.on("error", (error: Error & { level?: string }) => {
        const level = String(error?.level ?? "");
        const message = String(error?.message ?? "");
        if (level.includes("authentication") || /authentication/i.test(message)) {
          finish({
            ok: false,
            kind: "auth_failed",
            fingerprint: presented,
            detail: "The server did not accept that SSH key.",
          });
          return;
        }
        if (/host key|hostkey/i.test(message)) {
          finish({ ok: false, kind: "host_key_rejected", fingerprint: presented, detail: message.slice(0, 200) });
          return;
        }
        finish({
          ok: false,
          kind: /timed out|ETIMEDOUT/i.test(message) ? "timeout" : "unreachable",
          fingerprint: presented,
          detail: "I could not reach that server over SSH.",
        });
      });

      try {
        client.connect({
          host: target.host,
          port: target.port,
          username: target.username,
          privateKey: target.privateKey,
          passphrase: target.passphrase || undefined,
          readyTimeout: SSH_CONNECT_TIMEOUT_MS,
          keepaliveInterval: 0,
          algorithms: {
            cipher: [...SSH_ALGORITHMS.cipher],
            hmac: [...SSH_ALGORITHMS.hmac],
            serverHostKey: [...SSH_ALGORITHMS.serverHostKey],
          },
          // Identity is decided by the caller's pinning policy, never here.
          hostVerifier: (key: Uint8Array) => {
            presented = `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
            return acceptHostKey(presented);
          },
        });
      } catch {
        finish({
          ok: false,
          kind: "unreachable",
          fingerprint: presented,
          detail: "I could not open an SSH connection to that server.",
        });
      }
    });
  },
});