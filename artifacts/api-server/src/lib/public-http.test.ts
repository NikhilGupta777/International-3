import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPublicHttpUrl,
  buildArtifactFetchInit,
  fetchPublicUrl,
  isInternalHost,
} from "./public-http";

const publicLookup = async () => [{ address: "93.184.216.34" }];

test("artifact credentials are restricted to trusted internal requests", () => {
  const externalHeaders = new Headers(buildArtifactFetchInit(false, "session=private", "secret").headers);
  const internalHeaders = new Headers(buildArtifactFetchInit(true, "session=private", "secret").headers);
  assert.equal(externalHeaders.get("cookie"), null);
  assert.equal(externalHeaders.get("x-internal-agent"), null);
  assert.equal(internalHeaders.get("cookie"), "session=private");
  assert.equal(internalHeaders.get("x-internal-agent"), "secret");
});

test("private and DNS-resolved private addresses are rejected", async () => {
  assert.equal(isInternalHost("127.0.0.1"), true);
  assert.equal(isInternalHost("169.254.169.254"), true);
  assert.equal(isInternalHost("::ffff:7f00:1"), true);
  await assert.rejects(() => assertPublicHttpUrl("http://127.0.0.1/private"), /internal\/private/);
  await assert.rejects(
    () => assertPublicHttpUrl("https://public.example/file", {
      lookup: async () => [{ address: "10.0.0.5" }],
    }),
    /resolves to an internal\/private network/,
  );
});

test("every redirect target is validated before it is fetched", async () => {
  const requested: string[] = [];
  const fakeFetch: typeof globalThis.fetch = async input => {
    requested.push(String(input));
    return new Response(null, {
      status: 302,
      headers: { location: "http://169.254.169.254/latest/meta-data" },
    });
  };

  await assert.rejects(
    () => fetchPublicUrl("https://public.example/file", {}, 5, {
      fetch: fakeFetch,
      lookup: publicLookup,
    }),
    /internal\/private/,
  );
  assert.deepEqual(requested, ["https://public.example/file"]);
});

test("public redirects are followed without changing request headers", async () => {
  const seenHeaders: Array<string | null> = [];
  const fakeFetch: typeof globalThis.fetch = async (input, init) => {
    seenHeaders.push(new Headers(init?.headers).get("x-test"));
    if (String(input) === "https://one.example/file") {
      return new Response(null, { status: 302, headers: { location: "https://two.example/file" } });
    }
    return new Response("ok", { status: 200 });
  };

  const response = await fetchPublicUrl(
    "https://one.example/file",
    { headers: { "x-test": "safe" } },
    5,
    { fetch: fakeFetch, lookup: publicLookup },
  );
  assert.equal(await response.text(), "ok");
  assert.deepEqual(seenHeaders, ["safe", "safe"]);
});
