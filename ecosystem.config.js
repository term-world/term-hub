module.exports = {
  apps : [{
    name   : "term-hub",
    script : "./hub.js",
    exec_mode: "fork",
    watch: [".env"],
    ignore_watch:["sessions"]
  }]
}
