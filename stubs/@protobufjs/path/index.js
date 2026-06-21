const path = require("path");
exports.resolve = (origin, target, alreadyNormalized) => path.resolve(path.dirname(origin), target);
exports.normalize = (p) => path.normalize(p);
exports.isAbsolute = (p) => path.isAbsolute(p);