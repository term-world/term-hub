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

let pid = 1000;
let ports = []
let addresses = {}

// Docker setup
const Docker = require("dockerode");
      ishmael = new Docker({socketPath: '/var/run/docker.sock'});

// Operations

const port = () => {
  while(true) {
    pid++;
    if(!ports.hasOwnProperty(pid)) {
      ports.push(pid);
      break;
    }
  }
  return pid;
}

const address = (container, fn) => {
  container.inspect((err,data) => {
    let addr = data.NetworkSettings.Networks.bridge.IPAddress;
    if(!addr) { address(container,fn) }
    else { fn(addr) }
  });
}

const connect = (addr, fn) => {
  http.get({ host:addr, port: `${addresses[addr]}`, path: '/' }, (res) => {
    fn();
  }).on('error', (err) => {
    connect(addr, fn);
  });
};

server.get('/start', (req, res) => {
  var pid = port();
  let user = req.headers['x-forwarded-user'];
  ishmael.run('world', [], undefined, {
    "Hostname": "term-world",
    "Env": [`VS_USER=${user}`],
    "ExposedPorts": {"8000/tcp":{}},
    "HostConfig": {
      "Binds": [`/home/${user}:/home/${user}`],
      "PortBindings": {
        "8000/tcp": [
          {
            "HostPort": "8000"
          }
        ]
      }
    }
  }, (err,data,container) => {
    console.log(`[ERROR] ${err}`);
  }).on('container', (container) => {
    address(container, (addr) => {
      addresses[addr] = pid;
      console.log(`[CONTAINER] Started at ${addr}`);
      connect(addr, () => {
        res.redirect('/');
      });
    })
  });
});
