export default {
  input: "lib/module.js",
  output: {
    file: "lib/module.cjs",
    format: "cjs"
  },
  external: [
    "android-tools-bin"
  ]
};