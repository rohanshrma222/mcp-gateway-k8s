/**
 * The WooCommerce application password, read from a mounted Secret file.
 *
 * Why a file and not an environment variable: environment variables are fixed for the
 * life of a process, so rotating the credential would mean restarting every woo-mcp pod.
 * Kubernetes updates a mounted Secret in place, so reading from the file means a rotation
 * is picked up by a running process.
 *
 * Why the mtime check: reading the file on every single request would be a syscall per
 * tool call for a value that changes roughly never. Caching on mtime gives both - one
 * stat per call instead of a read, and automatic pickup when the Secret actually changes.
 *
 * The detail that makes it work: Kubernetes does not write Secret files in place. It
 * writes a new timestamped directory and atomically swaps a symlink, so there is no
 * window where a reader sees a half-written file, and the resolved file's mtime changes.
 * `stat` follows symlinks, so it observes that change.
 */
import { readFile, stat } from 'node:fs/promises';

export class CredentialFile {
  #cached: { value: string; mtimeMs: number } | undefined;

  constructor(private readonly path: string) {}

  async read(): Promise<string> {
    const stats = await stat(this.path);
    if (this.#cached && this.#cached.mtimeMs === stats.mtimeMs) {
      return this.#cached.value;
    }
    // Trailing newlines are the single most common way a file-mounted credential fails:
    // the value looks identical in every log and the server rejects it.
    const value = (await readFile(this.path, 'utf8')).trim();
    if (!value) {
      throw new Error(`credential file ${this.path} is empty`);
    }
    this.#cached = { value, mtimeMs: stats.mtimeMs };
    return value;
  }
}
