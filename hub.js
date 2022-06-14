"use strict";

// Set up server packages; create session

const express = require('express');
const sessions = require('express-session');
const cookies = require('cookie-parser');
const crypto = require('crypto');
const http = require('http');
const net = require('net');

const session = sessions({
  secret: crypto.randomBytes(10).toString("hex"),
  resave: true,
  saveUninitialized: true
});

let server = express()

server.use(session);
server.use(cookies());

// Listen for incoming traffic on port 8080

const app = http.createServer(server);
app.listen(8080);

// Define constants
const timeout = 1800000;

// Create registries (ports occupied, containers running)

let ports = [80, 443, 4180, 8080, 5000];
let registry = { };

// Docker setup

const Docker = require("dockerode");
const ishmael = new Docker({socketPath: '/var/run/docker.sock'});

// Operations

/**
 * Creates random port assignment between 1000 and 65535
 * @function randomize
 * @private
 * @param {String}  lower   Lower limit of random range
 * @param {String}  upper   Upper limit of random range
 */
const randomize = (lower, upper) => {
  return Math.floor(Math.random() * (upper - lower) + lower);
}

// Create random port as starting point

//let pid = randomize(1000, 65535);

/**
 * Discovers ports already in use
 * @function occupied
 * @private
 * @param {String}    port  Port to query
 * @param {Function}  fn    Callback
 */
const occupied = (port) => {
  let server = net.createServer((socket) => {
    socket.write('Ping\r\n');
    socket.pipe(socket);
  });
  server.on("error", (err) => {
    return true;
  });
  server.on("listening", (success) => {
    server.close();
    return false;
  });
  server.listen(port, '0.0.0.0');
}

/**
 * Generates a unique port for new containers
 * @function port
 * @private
 */
const port = () => {
  let pid = randomize(1000, 65535);
  while(true) {
    let used = occupied(port);
    if(!ports.hasOwnProperty(pid)) {
      console.log(pid);
      ports.push(pid);
      break;
    }
    pid = randomize(1000, 65535);
  }
  return pid;
}

/**
 * Acquires address from a container's properties
 * @function address
 * @private
 * @param {Container} container Instance of an individual container
 * @param {Function}  fn        Callback function
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
 * @param {Function}  fn    Callback function
 */
const connect = (user, fn) => {
  let port = registry[user].params.port
  // Make request to the container's endpoint to establish connection
  http.get({ host: "0.0.0.0", port: port, path: `/` }, (res) => {
    fn();
  }).on('error', (err) => {
    // On error, continue to try connection until connection established
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

// Set up generic proxies

const httpProxy = require('http-proxy');
/*const proxy = httpProxy.createServer({
  secure: false,
  changeOrigin: true
});*/

/**
 * Acquires content at /login endpoint
 * @param {Object}  req   Web request
 * @param {Object}  res   Web response
 */
server.get('/login', (req, res) => {
  // Acquire random port
  let pid = port();
  console.log(pid);
  // Get authenticated user
  //console.log(req);
  //console.log(res);
  let user = req.headers['x-forwarded-user'];
  // Create container from Docker API
  ishmael.run('world', [], undefined, {
    'name': `${user}`,
    "Hostname": "term-world",
    "Env": [`VS_USER=${user}`],
    "ExposedPorts": {"8000/tcp":{}},
    "HostConfig": {
      "Binds": [`sum2022:/home`],
      "PortBindings": {
        "8000/tcp": [
          {
            "HostPort": pid.toString()
          }
        ]
      }
    }
  }, (err,data,container) => {
    // On container launch error, report error
    console.log(`[ERROR] ${err}`);
  }).on('container', (container) => {
    // On container creation, get container private address
    address(container, (addr) => {
      console.log(`[CONTAINER] Started at ${addr}`);
      // Update global registry
      updateRegistry({
        user: user,
        params: {
          container: container,
          address: addr,
          port: pid
        }
      });
      // Callback to redirect request
      connect(user, () => {
        res.redirect(`/`);
      });
    })
  });
});

/**
 * Acquires content at / endpoint
 * @param {Object}  req   Web request
 * @param {Object}  res   Web response
 */
server.get('/*', (req,res) => {
  let user = req.headers['x-forwarded-user'];
  if(!user) res.redirect("/login");
  console.log(`${user} is attempting to login...`);
  console.log(registry);
  const proxy = httpProxy.createServer({});
  proxy.web(req, res, {target: `http://0.0.0.0:${registry[user].params.port}/`});
  proxy.on("error", (err) => {
    console.log("ON PROXY HANDOVER");
    console.log(err);
  });
});

/**
 * Acquires content at /login endpoint
 * @param {Object}  req     Web request
 * @param {Object}  socket  Web response
 * @param {Object}  head    ?
 */
app.on("upgrade", (req, socket, head) => {
  let user = req.headers['x-forwarded-user'];
  console.log(`${user} being upgraded...`)
  // Create separate proxy for websocket requests to each container
  let wsProxy = httpProxy.createServer({});
  wsProxy.on("error", (err) => {
    console.log("ON PROXY UPGRADE");
    console.log(err);
  });
  session(req, {}, () => {
    wsProxy.ws(req, socket, head, {target: `ws://localhost:${registry[user].params.port}`});
    socket.on("data", (data) => {
      let active = (new Date()).getTime();
      registry[user].params.active = active;
    });
    socket.on("error", (err) => {
      console.log("[ERROR] Socket error during websocket comm");
    });
    socket.on("close", () => {
      let container = registry[user].params.container;
      container.kill((err, data) => {
        console.log(data);
      });
    });
  });
});

/**
 * Event handler for server-side errors
 * @param {String} err  Error message
 */
server.on("error", err => console.log(err));

/**
 * Event handler for proxy-side errors
 * @param {String} err  Error message
 */
app.on("error", err => console.log(err));

process.on("SIGINT", (sig) => {
  for(let entry in registry) {
    let container = registry[entry].params.container;
    container.kill((err, data) => {
      console.log("[CONTAINER] Kill all");
    });
  }
  process.exit();
});
