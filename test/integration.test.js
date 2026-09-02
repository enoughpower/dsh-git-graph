/**
 * Integration smoke test: build a real git repository, boot the plugin's
 * `apply()` against a stub webServer, serve the registered `/git` and `/fs`
 * routes over a real HTTP server, and drive them end-to-end with fetch().
 *
 * Run with: node --test test/integration.test.js
 * Requires `git` on PATH (git >= 2.28 for `-b`).
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/index.js";

const execFileAsync = promisify(execFile);

let repo;
let server;
let port;
let routes;

function captureRoutes() {
  const registrations = [];
  const ctx = {
    webServer: {
      register(route) {
        registrations.push(route);
        return () => {};
      },
    },
    effect(cb) {
      return cb();
    },
  };
  apply(ctx);
  return registrations;
}

function gitRun(cwd, args) {
  return execFileAsync("git", args, { cwd, encoding: "utf8" });
}

async function post(pathname, body) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

before(async () => {
  repo = await mkdtemp(join(tmpdir(), "dsh-git-graph-it-"));
  await gitRun(repo, ["init", "-q", "-b", "main"]);
  await gitRun(repo, ["config", "user.email", "test@example.com"]);
  await gitRun(repo, ["config", "user.name", "Test User"]);
  await writeFile(join(repo, "a.txt"), "hello\n");
  await gitRun(repo, ["add", "-A"]);
  await gitRun(repo, ["commit", "-q", "-m", "initial"]);

  routes = captureRoutes();
  assert.equal(routes.length, 1, "git-only mode: apply() must register exactly /git");

  server = http.createServer((req, res) => {
    const route = routes.find((r) => req.url === r.path);
    if (!route) {
      res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: { code: "no-route", message: req.url } }));
      return;
    }
    route.handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (repo) await rm(repo, { recursive: true, force: true });
});

test("apply() exposes /git only (file browser /fs disabled for now)", async () => {
  assert.ok(routes.some((r) => r.path === "/git"));
  assert.ok(!routes.some((r) => r.path === "/fs"), "git-only mode: /fs must not be registered");
});

test("apply() skips gracefully when /git is already registered (desktop built-in conflict)", () => {
  const exact = new Map();
  const ws = {
    register(route) {
      if (exact.has(route.path)) throw new Error(`webserver: duplicate exact route "${route.path}"`);
      exact.set(route.path, route);
      return () => exact.delete(route.path);
    },
  };
  // Simulate the desktop app's built-in git viewer already owning the routes.
  ws.register({ kind: "exact", path: "/git", handler: () => {} });
  const ctx = { webServer: ws, effect(cb) { return cb(); } };
  assert.doesNotThrow(() => apply(ctx)); // must not crash the layer
  assert.equal(exact.size, 1); // routes stay owned by the built-in plugin
});

test("/git status reports the working tree split", async () => {
  await writeFile(join(repo, "a.txt"), "hello world\n");
  await writeFile(join(repo, "b.txt"), "new\n");
  const res = await post("/git", { op: "status", path: repo });
  assert.equal(res.ok, true);
  assert.equal(res.value.branch, "main");
  assert.deepEqual(res.value.unstaged.map((f) => f.path), ["a.txt"]);
  assert.deepEqual(res.value.untracked.map((f) => f.path), ["b.txt"]);
});

test("/git stage + status flips a file to staged", async () => {
  const staged = await post("/git", { op: "stage", path: repo, files: ["a.txt"] });
  assert.equal(staged.ok, true);
  const status = await post("/git", { op: "status", path: repo });
  assert.deepEqual(status.value.staged.map((f) => f.path), ["a.txt"]);
});

test("/git commit of selected files records a commit and clears it", async () => {
  const commit = await post("/git", { op: "commit", path: repo, message: "edit a", files: ["a.txt"] });
  assert.equal(commit.ok, true, JSON.stringify(commit));
  const status = await post("/git", { op: "status", path: repo });
  assert.equal(status.value.staged.length, 0);
  assert.deepEqual(status.value.untracked.map((f) => f.path), ["b.txt"]);
});

test("/git log lists both commits", async () => {
  const res = await post("/git", { op: "log", path: repo, n: 10 });
  assert.equal(res.ok, true);
  assert.ok(res.value.commits.length >= 2);
  assert.equal(res.value.commits.at(-1).subject, "initial");
});

test("/git graphLog returns rows with parents for a commit graph", async () => {
  const res = await post("/git", { op: "graphLog", path: repo, n: 10 });
  assert.equal(res.ok, true);
  assert.ok(res.value.rows.length >= 2);
  assert.ok(res.value.rows.every((r) => r.hash && r.subject));
});

test("/git blame annotates a committed file", async () => {
  const res = await post("/git", { op: "blame", path: repo, file: "a.txt" });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(res.value.lines.length >= 1);
  assert.equal(res.value.lines[0].content, "hello world");
});

test("/git rejects unknown ops, bad JSON and non-POST", async () => {
  const badOp = await post("/git", { op: "nope", path: repo });
  assert.equal(badOp.ok, false);
  assert.equal(badOp.error.code, "bad-op");

  const badJson = await fetch(`http://127.0.0.1:${port}/git`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not-json",
  }).then((r) => r.json());
  assert.equal(badJson.error.code, "bad-json");

  const wrongMethod = await fetch(`http://127.0.0.1:${port}/git`).then((r) => r.json());
  assert.equal(wrongMethod.error.code, "method");
});

test("/fs is not served in git-only mode", async () => {
  const res = await post("/fs", { op: "tree", root: repo });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "no-route");
});
