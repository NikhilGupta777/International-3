module.exports = function fetch(filename, options, callback) {
  if (typeof options === "function") { callback = options; options = {}; }
  if (typeof callback === "function") { callback(new Error("fetch stub: not implemented")); return; }
  return Promise.reject(new Error("fetch stub: not implemented"));
};