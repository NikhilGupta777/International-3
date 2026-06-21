// Stub for protobufjs — satisfies @google/genai's optional Live-API dep.
// Regular generateContent calls never touch protobuf at runtime.
"use strict";

class Root {
  constructor() { this.nested = {}; }
  add() { return this; }
  lookup() { return null; }
  resolveAll() { return this; }
  loadSync() { return this; }
  toJSON() { return {}; }
}

class Type {
  constructor() {}
  encode() { return { finish: () => Buffer.alloc(0) }; }
  decode() { return {}; }
  verify() { return null; }
  create() { return {}; }
  toObject() { return {}; }
}

class Enum {
  constructor(name, values) { this.name = name; this.values = values || {}; }
}

class Field {
  constructor() {}
}

class Namespace {
  constructor() {}
  add() { return this; }
  lookup() { return null; }
}

function load(filename, options, callback) {
  if (typeof options === "function") { callback = options; }
  const root = new Root();
  if (typeof callback === "function") {
    setTimeout(() => callback(null, root), 0);
    return Promise.resolve(root);
  }
  return Promise.resolve(root);
}

function loadSync() { return new Root(); }

const protobuf = {
  load,
  loadSync,
  Root,
  Type,
  Enum,
  Field,
  Namespace,
  util: {
    isString: (v) => typeof v === "string",
    isInteger: Number.isInteger,
    toLong: (n) => n,
    newError: (msg) => new Error(msg),
    base64: { decode: () => Buffer.alloc(0), encode: () => "", test: () => false },
    utf8: { read: () => "", write: () => 0, length: () => 0 },
    pool: (alloc, slice) => alloc,
    Buffer: Buffer,
  },
  configure: () => {},
  Writer: { create: () => ({ finish: () => Buffer.alloc(0), bytes: () => Buffer.alloc(0) }) },
  Reader: { create: () => ({}) },
};

module.exports = protobuf;
module.exports.default = protobuf;
