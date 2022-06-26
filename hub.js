"use strict";

const fs = require('fs');
const net = require('net');
const http = require('http');
const express = require('express');
const EventEmitter = require('events');
const env = require('dotenv').config();
const cookies = require('cookie-parser');
const sessions = require('express-session');
const sessionFile = require('session-file-store')(sessions);

const session = sessions({
  secret: process.env.COOKIE_SECRET,
  resave: true,
  saveUninitialized: true,
  store: new sessionFile()
});

let server = express();

server.use(session);
server.use(cookies());

let sess;

// Listen for incoming traffic on port 8080

const app = http.createServer(server);
app.listen(8080);

// Define constants
const timeout = 1800000;

// Create registries (ports occupied, containers running)

let ports = [80, 443, 4180, 5000, 8000, 8080];
let registry = { };

// Docker setup

const Docker = require("dockerode");
const ishmael = new Docker({socketPath: '/var/run/docker.sock'});
const status = fs.statSync("/var/run/docker.sock");

// Create event emitter

const emitter = new EventEmitter();

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
  let port = registry[user].params.port;
  http.get({ host: "0.0.0.0", port: port, path: `/` }, (res) => {
    fn();
  }).on('error', (err) => {
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
  if(!registry[user]) registry[user] = { "params": { } }
  for(let param in params) {
    registry[user]["params"][param] = params[param]
  }
}

// Operations

let directory;
fs.readFile(process.env.DIRECTORY, (err, data) => {
  directory = JSON.parse(data);
});

for(let entry in directory) {
	updateRegistry({
		user: entry,
		params: {
			district: directory[entry]
		}
	});
}

// Set up generic proxies

const httpProxy = require('http-proxy');

/**
 * Acquires content at /login endpoint
 * @param {Object}  req   Web request
 * @param {Object}  res   Web response
 */
server.get('/login', (req, res) => {
  // Acquire random port
  let pid = port();
  // Get authenticated user
  let user = req.headers['x-forwarded-user'] || req.session.user;
  if(user === undefined) { res.redirect('/login'); }
  sess = req.session;
  sess.user = user;
  // Create container from Docker API
  let district = directory[user].district;
  ishmael.run(`world:${process.env.IMAGE}`, [], undefined, {
    'name': `${user}`,
    'label': `${user}`,
    "Hostname": "term-world",
    "Env": [
      `VS_USER=${user}`,
      `DISTRICT=${district}`
    ],
    "ExposedPorts": {"8000/tcp":{}},
    "HostConfig": {
      "Binds": [`sum2022:/world`],
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
    if(err) {
      console.log(err);
    }
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
          port: pid,
          sockets: 0
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
  let user = req.session.user;
  //if(user === undefined) { res.redirect('/login'); }
  const proxy = httpProxy.createServer({});
  proxy.web(req, res, {target: `http://0.0.0.0:${registry[user].params.port}/`});
  proxy.on("error", (err) => {
    console.log(err);
  });
});

/**
 * Handles transfer of HTTP protocol to web sockets
 * @param {Object}  req     Web request
 * @param {Object}  socket  Socket created
 * @param {Object}  head    ?
 */

app.on('upgrade', (req, socket, head) => {
  let user;
  let proxy = httpProxy.createServer({});
  session(req, {}, () => {
    user = req.session.user;
    proxy.ws(req, socket, head, {target: `http://localhost:${registry[user].params.port}/`}); 
    registry[user].params.sockets++;
  });
  socket.on('close', () => {
    registry[user].params.sockets--;
    if(registry[user].params.sockets == 0) {
      emitter.emit('SIGUSER',user);
    }
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

//Remove the container on SIGINT or exit

const exit = () => {
  process.exit();
};

async function spindown(sig) {
  let args = sig[0] == 'USER' ? {label: sig[1]} : {all: true};
  let list = await ishmael.listContainers(args);
  for await (let entry of list) {
    let container = await ishmael.getContainer(entry.Id);
    let stoppage = await container.stop();
    let removal = await container.remove();
  }
  let now = Math.floor(new Date().getTime() / 1000);
  let pruned = await ishmael.pruneContainers({until: now})
  if(args.all) { exit(); }
}

process.once("exit", spindown.bind());
process.once("SIGINT", spindown.bind());
process.once("SIGTERM", spindown.bind());
emitter.once('SIGUSER', async (user) => {
  await spindown(['USER', user]);
});