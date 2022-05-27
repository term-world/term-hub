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
let ports = [];
let registry = { };

// Proxy server for built containers
const httpProxy = require('http-proxy');
const proxy = httpProxy.createServer({});

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
  http.get({ host: addr, port: registry[addr].params.port, path: '/' }, (res) => {
    console.log("resolved");
    fn();
  }).on('error', (err) => {
    connect(addr, fn);
  });
};

const updateRegistry = (store) => {
  let addr = store.address;
  let params = store.params;
  if(!registry[addr]) registry[addr] = { }
  if(!registry[addr].params) registry[addr].params = { }
  for(let param in params) {
    registry[addr]["params"][param] = params[param]
  }
  console.log(registry);
}

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
            "HostPort": pid.toString()
          }
        ]
      }
    }
  }, (err,data,container) => {
    console.log(`[ERROR] ${err}`);
  }).on('container', (container) => {
    address(container, (addr) => {
      console.log(`[CONTAINER] Started at ${addr}`);
      updateRegistry({
        address: addr,
        params: {
          container: container,
          user: user,
          port: pid
        }
      });
      connect(addr, () => {
        console.log("Redirect...");
        res.redirect('/');
      });
    })
  });
});

server.get('/', (req,res) => {
  proxy.web(req, res, {target: `http://${addr}:${registry[addr].params.port}`});
});
