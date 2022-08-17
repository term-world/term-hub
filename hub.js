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
  saveUninitialized: false,
  store: new sessionFile()
});

let server = express();

server.use(session);
server.use(cookies());

let sess;
let interrupt;

// Listen for incoming traffic on port 8080

const app = http.createServer(server);
app.listen(8080);

// Create registries (ports occupied, containers running)

let ports = [80, 443, 4180, 5000, 8000, 8080];
let registry = { };

// Docker setup

const Docker = require("dockerode");
const ishmael = new Docker({socketPath: '/var/run/docker.sock'});

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

const now = () => {
  return Math.floor(new Date().getTime() / 1000);
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

// Event used to add information to global container registry

emitter.on('register', (store) => {
  if(!registry[store.user]) registry[store.user] = { "params": { } };
  for(let param in store.params) {
    registry[store.user].params[param] = store.params[param]
  }
});

// Read directory to pass the DISTRICT environment variable
let directory;

fs.readFile(process.env.DIRECTORY, (err, data) => {
  directory = JSON.parse(data);
});

// Set proxy object for web and socket proxies

const httpProxy = require('http-proxy');

/**
 * Acquires content at /login endpoint
 * @param {Object}  req   Web request
 * @param {Object}  res   Web response
 */
server.get('/login', (req, res) => {
  // Acquire random port
  let pid = port();
  // Get authenticated user from header or session
  let user;
  session(req, {}, () => {
    user =  req.headers['x-forwarded-user'] || req.session.user;
    // Set user property of session
    sess = req.session;
    sess.user = user;
  });
  // If neither header or session, redirect to authentication
  if(user === undefined) { return res.redirect('/login'); }
  // Create container from Docker API
  let userId = directory[user].uid;
  let district = directory[user].district;
  let districtId = directory[user].gid;
  ishmael.run(`world:${process.env.IMAGE}`, [], undefined, {
    "name": `${user}`,
    "Hostname": "term-world",
    "Env": [
      `VS_USER=${user}`,
      `VS_USER_ID=${userId}`,
      `DISTRICT=${district}`,
      `GID=${districtId}`
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
    if(err) { console.log(err); }
  }).on('container', (container) => {
    // On container creation, get container private address
    address(container, (addr) => {
      emitter.emit('register',
        {
          user: user,
          params: {
            port: pid,
            sockets: 0,
            address: addr,
            container: container
          }
        }
      );
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
  let user;
  session(req, {}, () =>  {
    user = req.session.user;
  });
  if(
    user === undefined ||
    registry[user] === undefined
  ) {
    return res.redirect('/login');
  }
  const proxy = httpProxy.createServer({});
  proxy.web(req, res,
    {target: `http://localhost:${registry[user].params.port}/`}
  );
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
    if(user === undefined) { return; }
    proxy.ws(req, socket, head,
      {target: `http://localhost:${registry[user].params.port}/`}
    );
    registry[user].params.sockets++;
  });
  socket.on('ping', () => {
    socket.pong();
  });
  socket.on('data', () => {
    emitter.emit('register',
      {
        user: user,
        params: {
          active: now()
        }
      }
    );
  });
  socket.on('close', () => {
    socket.end();
    socket.destroy();
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

// Remove containers after idle status (TIMEOUT in seconds)

let timeout = process.env.TIMEOUT || 900;

setInterval(() => {
  const timed = Object
    .keys(registry)
    .filter((user, idx, self) => {
      let lastActive = registry[user].params.active;
      return now() - lastActive > timeout;
    });
  for (let entry in timed) {
    let user = timed[entry];
    let id = registry[user].params.container.id;
    emitter.emit('SIGUSER', id);
    delete registry[user];
  }
}, 10000);

//Remove the container on SIGINT or exit

const exit = () => {
  process.exit();
};

async function spindown(sig) {
  let args = sig[0] == 'USER' ? { filters: {"id":[`${sig[1]}`]} } : {all: true};
  console.log(args);
  if(args.all) { interrupt = true; }
  let list = await ishmael.listContainers(args);
  for await (let entry of list) {
    let container = await ishmael.getContainer(entry.Id);
    let stoppage = await container.stop();
    let removal = await container.remove();
  }
  let pruned = await ishmael.pruneContainers({until: now()})
  if(args.all) { exit(); }
}

process.on("SIGINT", spindown.bind());
process.on("SIGTERM", spindown.bind());

// Nonce custom signal to indicate single user container spindown

emitter.on('SIGUSER', (id) => {
  spindown(['USER', id]);
});
