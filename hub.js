"use strict";

// Set up server packages; create session

const express = require('express');
const sessions = require('express-session');
const cookies = require('cookie-parser');
const crypto = require('crypto');
const http = require('http');

const session = sessions({
  secret: crypto.randomBytes(10).toString("hex"),
  resave: true,
  saveUninitialized: true
});

let server = express()

server.use(session);
server.use(cookies());

// Listen for incoming traffic on port 8080

let app = http.createServer(server);
app.listen(8080);

// Define constants

//let pid = 1000;
let ports = [80, 4180, 8080];

let registry = { };

let timeout = 1800000;

// Docker setup

const Docker = require("dockerode");
const ishmael = new Docker({socketPath: '/var/run/docker.sock'});

// Operations

/**
 * Generates a unique port for new containers
 * @function port
 * @private
 */
const port = () => {
  let pid = 1000;
  while(true) {
    if(!ports.hasOwnProperty(pid)) {
      ports.push(pid);
      break;
    }
    pid = Math.floor(64535) + 1000;
  }
  return pid;
}

/**
 * Acquires address from a container's properties
 * @function address
 * @private
 * @param {Container} container Instance of an individual container
 * @param {function}  fn        Callback function
 */
const address = (container, fn) => {
  container.inspect((err,data) => {
    let addr = data.NetworkSettings.Networks.bridge.IPAddress;
    if(!addr) { address(container,fn) }
    else { fn(addr) }
  });
}

/**
 * Attempts to connect to the container on the generated port
 * @function connect
 * @private
 * @param {String}    user  Username of user from x-forwarded-user
 * @param {function}  fn    Callback function
 */
const connect = (user, fn) => {
  let port = registry[user].params.port
  http.get({ host: "0.0.0.0", port: port, path: `/` }, (res) => {
    fn();
  }).on('error', (err) => {
    console.log(err);
    connect(user, fn);
  });
};

/**
 * Adds user information to global registry object
 * @function updateRegistry
 * @private
 * @param {Object} store  Object containing various parameters to add to the registry
 */
const updateRegistry = (store) => {
  let user = store.user;
  let params = store.params;
  if(!registry[user]) registry[user] = { }
  if(!registry[user].params) registry[user].params = { }
  for(let param in params) {
    registry[user]["params"][param] = params[param]
  }
}

/**
 * Removes idle containers
 * @function cullIdle
 * @private
 */
const cullIdle = () => {
  let time = (new Date()).getTime();
  for (let entry in registry) {
    let idle = time - registry[entry].params.active;
    if(idle > timeout) {
      remove(entry, () => { });
    }
  }
}

/**
 * Removes and kills containers
 * @function remove
 * @private
 * @param {String}    entry   Username to look up in global registry
 * @param {function}  fn      Callback function
 */
const remove = (entry, fn) => {
  let container = registry[entry].params.container;
  console.log(`[CONTAINER] Killing ${entry} container at ${registry[entry].params.address}`);
  container.kill((err, res) => {
    console.log(`[CONTAINER] Killing...`);
    if(err){
      fn();
    } else {
      container.remove((err, res) => {
        console.log(`[CONTAINER] Removing...`);
        fn();
      });
    }
  });
  delete registry[entry];
}

const httpProxy = require('http-proxy');
const proxy = httpProxy.createServer({});

// Set up endpoints

server.get('/login', (req, res) => {
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
        user: user,
        params: {
          container: container,
          address: addr,
          port: pid
        }
      });
      connect(user, () => {
        res.redirect(`/`);
      });
    })
  });
});

server.get('/*', (req,res) => {
  let user = req.headers['x-forwarded-user'];
  console.log(`[PROXY] ${registry[user].params.address}`);
  proxy.web(req, res, {target: `http://localhost:${registry[user].params.port}`});
});

app.on("upgrade", (req, socket, head) => {
  let user = req.headers['x-forwarded-user'];
  // Proxy server for built containers
  let wsProxy = httpProxy.createServer({});
  session(req, {}, () => {
    wsProxy.ws(req, socket, head, {target: `ws://localhost:${registry[user].params.port}`});
    socket.on("data", (data) => {
      let active = (new Date()).getTime();
      registry[user].params.active = active;
    });
    socket.on("error", (err) => {
      console.log("SOCKET HANGUP");
    });
  });
});

app.on("error", err => console.log(err));

setInterval(
  cullIdle,
  timeout
);

process.on('exit', () => {
  for(let entry in registry) {
    remove(entry, () => { });
  }
});

process.on('SIGINT', () => {
  console.log("[SIGINT] Received SIGINT");
  for(let entry in registry) {
    remove(entry, () => {});
  }
  process.exit();
});
