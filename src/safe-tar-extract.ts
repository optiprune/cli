import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { randomUUID } from "node:crypto";

/** Extract regular files/directories from an npm gzip tarball without writing outside targetDir. */
export async function extractTarGz(tarGzBuffer: Buffer, targetDir: string): Promise<void> {
  const tarBuffer = zlib.gunzipSync(tarGzBuffer);
  fs.mkdirSync(targetDir, { recursive: true });
  const root = fs.realpathSync(targetDir);
  let offset = 0;

  while (offset + 512 <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const name = readTarString(header.subarray(0, 100));
    const prefix = readTarString(header.subarray(345, 500));
    const rawName = prefix ? `${prefix}/${name}` : name;
    const sizeText = readTarString(header.subarray(124, 136));
    const size = sizeText ? Number.parseInt(sizeText, 8) : 0;
    const typeFlag = String.fromCharCode(header[156] ?? 0);
    const dataOffset = offset + 512;
    const nextOffset = dataOffset + Math.ceil(size / 512) * 512;
    if (!Number.isSafeInteger(size) || size < 0 || dataOffset + size > tarBuffer.length || nextOffset > tarBuffer.length) {
      throw new Error(`Invalid tar entry size for ${JSON.stringify(rawName)}`);
    }
    offset = nextOffset;

    if (!rawName) continue;
    const relativeName = rawName.startsWith("package/") ? rawName.slice("package/".length) : rawName;
    const portableName = relativeName.replace(/\\/g, "/");
    if (portableName.startsWith("/") || /^[A-Za-z]:/.test(portableName) || portableName.split("/").includes("..")) {
      throw new Error(`Refusing unsafe tar path: ${JSON.stringify(rawName)}`);
    }
    const parts = portableName.split("/").filter((part) => part !== "" && part !== ".");
    if (parts.length === 0) continue;
    if (parts.some((part) => /^[A-Za-z]:/.test(part))) {
      throw new Error(`Refusing drive-qualified tar path: ${JSON.stringify(rawName)}`);
    }
    const destination = path.resolve(root, ...parts);
    const relativeToRoot = path.relative(root, destination);
    if (relativeToRoot === ".." || relativeToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToRoot)) {
      throw new Error(`Refusing tar path outside installation directory: ${JSON.stringify(rawName)}`);
    }

    if (typeFlag === "5" || rawName.endsWith("/")) {
      ensureDirectory(root, destination);
      continue;
    }
    if (typeFlag !== "0" && typeFlag !== "\0") continue;

    ensureDirectory(root, path.dirname(destination));
    if (fs.existsSync(destination)) {
      const existing = fs.lstatSync(destination);
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new Error(`Refusing to overwrite non-regular tar destination: ${JSON.stringify(rawName)}`);
      }
    }
    const temporaryFile = path.join(path.dirname(destination), `.optiprune-${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporaryFile, tarBuffer.subarray(dataOffset, dataOffset + size), { flag: "wx" });
      fs.renameSync(temporaryFile, destination);
    } catch (error) {
      try { fs.unlinkSync(temporaryFile); } catch {}
      throw error;
    }
  }
}

function readTarString(value: Buffer): string {
  const nul = value.indexOf(0);
  return value.subarray(0, nul === -1 ? value.length : nul).toString("utf8");
}

/** Create missing directories one component at a time and reject symlink escapes. */
function ensureDirectory(root: string, directory: string): void {
  const relative = path.relative(root, directory);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Refusing to create a directory outside the installation directory");
  }
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (fs.existsSync(current)) {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`Refusing to extract through a non-directory or symlink: ${current}`);
      }
    } else {
      fs.mkdirSync(current);
    }
  }
}
