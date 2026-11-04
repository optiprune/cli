import assert from "node:assert/strict";
import { link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { fileURLToPath } from "node:url";

const extractTarGz = (await import(fileURLToPath(new URL("../dist/safe-tar-extract.js", import.meta.url)))).extractTarGz;

function makeTar(entries) {
  const blocks = [];
  for (const { name, content = "", type = "0" } of entries) {
    const body = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    header.write("0000644\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii");
    header.fill(0x20, 148, 156);
    header.write(type, 156, 1, "ascii");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    blocks.push(header);
    if (body.length) {
      blocks.push(body);
      const padding = (512 - (body.length % 512)) % 512;
      if (padding) blocks.push(Buffer.alloc(padding));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "optiprune-tar-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("extracts ordinary package files under the target", async (t) => {
  const root = await fixture(t);
  const target = path.join(root, "install");
  await extractTarGz(makeTar([{ name: "package/lib/index.js", content: "export const ok = true;\n" }]), target);
  assert.equal(await readFile(path.join(target, "lib/index.js"), "utf8"), "export const ok = true;\n");
});

test("rejects parent traversal and leaves files outside the target untouched", async (t) => {
  const root = await fixture(t);
  const target = path.join(root, "install");
  const outside = path.join(root, "escape.txt");
  await assert.rejects(
    extractTarGz(makeTar([{ name: "package/../../escape.txt", content: "owned" }]), target),
    /unsafe tar path|outside installation directory/i,
  );
  await assert.rejects(readFile(outside, "utf8"), { code: "ENOENT" });
});

test("rejects Windows-style traversal and absolute paths", async (t) => {
  const root = await fixture(t);
  const target = path.join(root, "install");
  await assert.rejects(extractTarGz(makeTar([{ name: "package/..\\..\\escape.txt", content: "bad" }]), target), /unsafe tar path/i);
  await assert.rejects(extractTarGz(makeTar([{ name: "/tmp/escape.txt", content: "bad" }]), target), /unsafe tar path/i);
  await assert.rejects(extractTarGz(makeTar([{ name: "package/sub/C:/escape.txt", content: "bad" }]), target), /drive-qualified tar path/i);
});

test("refuses to write through a pre-existing symlink inside the install target", async (t) => {
  const root = await fixture(t);
  const target = path.join(root, "install");
  const outside = path.join(root, "outside");
  await mkdir(target, { recursive: true });
  await mkdir(outside);
  await symlink(outside, path.join(target, "link"), "dir");
  await assert.rejects(
    extractTarGz(makeTar([{ name: "package/link/escape.txt", content: "owned" }]), target),
    /symlink/i,
  );
  await assert.rejects(readFile(path.join(outside, "escape.txt"), "utf8"), { code: "ENOENT" });
});

test("replaces an existing hard link atomically without changing its outside target", async (t) => {
  const root = await fixture(t);
  const target = path.join(root, "install");
  const outside = path.join(root, "outside.txt");
  await mkdir(target);
  await writeFile(outside, "keep this content");
  await link(outside, path.join(target, "victim.txt"));

  await extractTarGz(makeTar([{ name: "package/victim.txt", content: "replacement" }]), target);

  assert.equal(await readFile(outside, "utf8"), "keep this content");
  assert.equal(await readFile(path.join(target, "victim.txt"), "utf8"), "replacement");
});
