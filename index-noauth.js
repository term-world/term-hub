// Server setup
const express = require('express');
      sessions = require('express-session');
      cookies = require('cookie-parser');
      crypto = require('crypto');
      http = require('http');

session = sessions({
  secret: crypto.randomBytes(10).toString("hex"),
  resave: true,
  saveUninitialized: true
});

let server = express()

server.use(session);
server.use(cookies());

let app = server.listen(8080, ()=> { })

let ports = []

// Docker setup
const Docker = require("dockerode");
      ishmael = new Docker({socketPath: '/var/run/docker.sock'});

// Operations

const ip = () => {
  let pid = 1000;
  if(!ports.hasOwnProperty(pid)) {
    ports.push(pid);
  }
  pid++;
}

const address = (container, fn) => {
  container.inspect((err,data) => {
    let addr = data.NetworkSettings.Networks.bridge.IPAddress;
    if(!addr) { address(container,fn) }
    else { fn(addr) }
  });
}

const connect = (addr, fn) => {
  let port = ip();
  http.get({ host:addr, port: 8000, path: '/' }, (res) => {
    fn();
  }).on('error', (err) => {
    connect(addr, fn);
  });
};

server.get('/start', (req, res) => {
  let user = req.headers['x-forwarded-user'];
  ishmael.run('world', [], undefined, {
    "Hostname": "term-world",
    "Env": [`VS_USER=${user}`],
    "Binds": [`/home/${user}:/home/${user}`]
  }, (err,data,container) => {
    console.log(`[ERROR] ${err}`);
  }).on('container', (container) => {
    address(container, (addr) => {
      console.log(`[CONTAINER] Started at ${addr}`);
      connect(addr, () => {
        res.redirect('/');
      });
    })
  });
});
