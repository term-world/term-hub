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

let app = http.createServer(server);
app.listen(8080);

// Define constants

let ports = [80, 443, 4180, 8080];
let registry = { };
let timeout = 1800000;

// Docker setup

const Docker = require("dockerode");
const ishmael = new Docker({socketPath: '/var/run/docker.sock'});

// Operations

const randomize = (lower, upper) => {
  return Math.floor(Math.random() * (upper - lower) + lower);
}

// Create random port as starting point

let pid = randomize(1000, 65535);

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
  while(true) {
    let used = occupied(port)
    console.log(pid);
    if(!ports.hasOwnProperty(pid) && !used) {
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

/**
 * Acquires content at /login endpoint
 * @param {Object}  req   Web request
 * @param {Object}  res   Web response
 */
server.get('/login', (req, res) => {
  // Acquire random port
  var pid = port();
  // Get authenticated user
  let user = req.headers['x-forwarded-user'];
  // Create container from Docker APi
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
 * Acquires content at /* endpoint
 * @param {Object}  req   Web request
 * @param {Object}  res   Web response
 */
server.get('/*', (req,res) => {
  let user = req.headers['x-forwarded-user'];
  console.log(`[PROXY] ${registry[user].params.address}`);
  proxy.web(req, res, {target: `http://localhost:${registry[user].params.port}`});
});

/**
 * Acquires content at /login endpoint
 * @param {Object}  req     Web request
 * @param {Object}  socket  Web response
 * @param {Object}  head    ?
 */
app.on("upgrade", (req, socket, head) => {
  let user = req.headers['x-forwarded-user'];
  // Create separate proxy for websocket requests to each container
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

/**
 * Event handler for server-side errors
 * @param {String} err  Error message
 */
app.on("error", err => console.log(err));

setInterval(
  cullIdle,
  timeout
);

/**
 * Event handler for runtime exit errors
 */
process.on('exit', () => {
  for(let entry in registry) {
    remove(entry, () => { });
  }
});

/**
 * Event handler for SIGINT message
 */
process.on('SIGINT', () => {
  console.log("[SIGINT] Received SIGINT");
  for(let entry in registry) {
    remove(entry, () => {});
  }
  process.exit();
});
