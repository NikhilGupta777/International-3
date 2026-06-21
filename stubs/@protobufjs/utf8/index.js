exports.length = (s) => Buffer.byteLength(s, "utf8");
exports.read = (buf, start, end) => Buffer.from(buf).slice(start, end).toString("utf8");
exports.write = (s, buf, pos) => { const written = buf.write(s, pos, "utf8"); return pos + written; };