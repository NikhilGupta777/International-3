exports.length = (s) => Math.ceil(s.length / 4) * 3;
exports.encode = (buf, start, end) => Buffer.from(buf).slice(start, end).toString("base64");
exports.decode = (s, buf, offset) => { const b = Buffer.from(s, "base64"); b.copy(buf, offset); return b.length; };
exports.test = (s) => /^[A-Za-z0-9+/]*={0,2}$/.test(s);