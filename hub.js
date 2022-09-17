"use strict";

// Imports

const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const express = require('express');
const emitter = require('events');
const env = require('dotenv').config();
const httpProxy = require('http-proxy');
const cookies = require('cookie-parser');
const exec = require('child_process').exec;
const sessions = require('express-session');
const sessionFile = require('session-file-store')(sessions);

// Create sessions

const session = sessions({
  secret: process.env.COOKIE_SECRET,
  resave: true,
  saveUninitialized: false,
  store: new sessionFile()
});

// Create global for accessing sessions
let userSession;

// Create app server

let server = express();
server.use(session);
server.use(cookies());

// Listen for incoming traffic

const app = http.createServer(server);
app.listen(8080);

// Create reserved port registry
let ports = [8000, 8080];

// Docker daemon setup

const docker = require("dockerode");
const moby = new docker({socketPath: '/var/run/docker.sock'});

// Setup event emitter

const events = new emitter();

// Setup global activity tracker

let activity = {}

/**
 * Event used to store last active times
 * @param {Object} store    Packet of active state info
 */
events.on('updateLastActive', (store) => {
  activity[store.user] = { "lastActive": store.lastActive };
});

/**
 * Discover ports already in use
 * @function isOccupiedPort
 * @private
 * @param {String}  port  Port to query
 */
const isOccupiedPort = (port) => {
  let local = net.createServer( (socket) => {
    socket.write('Ping\r\n');
    socket.pipe(socket);
  });
  local.on("error", (err) => {
    return true;
  });
  local.on("listening", (success) => {
    local.close();
    return false;
  });
  local.listen(port, "0.0.0.0");
};

/**
 * Creates random port assignment 1000-65535
 * @function randomPort
 * @private
 * @param {String} lower  Lower limit of random range
 * @param {String} upper  Upper limit of random range
 */
const randomPort = (lower, upper) => {
  let port;
  do {
    port = Math.floor(Math.random() * (upper - lower) + lower);
  } while(isOccupiedPort(port));
  ports.push(port);
  return port;
};

/**
 * Get current time on request
 * @function now
 * @private
 */
const now = () => {
  return Math.floor(new Date().getTime() / 1000);
};

/**
 * Retrieve container data from running container(s)
 * @function containerData
 * @param {String} user   Authenticated user requesting container
 */
const containerData = async (user) => {
  let container;
  let containers = await moby.listContainers({names: user});
  for await(let entry of containers) {
    let acquired = await moby.getContainer(entry.Id);
    container = await acquired.inspect();
    return await {
      id: container.Id,
      port: container.NetworkSettings.Ports['8000/tcp'][0].HostPort
    }
  }
  return await {
    id: null,
    port: null
  }
};

/**
 * Read global user directory for user details
 * @function readDirectory
 * @private
 */
let directory;

const readDirectory = () => {
  let json = fs.readFileSync(process.env.DIRECTORY);
  directory = JSON.parse(json);
}

/**
 * Start a new container for users requiring one
 * @function startContainer
 * @private
 * @param {String} user       User requesting a container
 * @param {String} port       Port binding for new container
 * @param {Object} directory  Directory of relevant user data
 */
const startContainer = (user) => {
  let uid = directory[user].uid;
  let gid = directory[user].gid
  let district = directory[user].district;
  moby.run(`world:${process.env.IMAGE}`, [], undefined, {
    "name": `${user}`,
    "Hostname": "term-world",
    "Env": [
      `VS_USER=${user}`,
      `VS_USER_ID=${uid}`,
      `DISTRICT=${district}`,
      `GID=${gid}`
    ],
    "ExposedPorts": { "8000/tcp":{} },
    "HostConfig": {
      "Binds": [`${process.env.VOLUME}:/world`],
      "PortBindings": {
        "8000/tcp": [
          {
            "HostPort": `${randomPort(1000,65535)}`
          }
        ]
      }
    }
  }, (err, data, container) => {
    if(err) throw err;
  });
}

/**
 * Attempt connection to requested container on generated port
 * @function connectContainer
 * @private
 * @param {String} user   Authenticated user requresting container
 */
const connectContainer = async (user, callback) => {
  let world = await containerData(user);
  http.get({
    host: "0.0.0.0",
    port: world.port,
    path: "/"
  }, (res) => {
    callback();
  }).on("error", (err) => {
    connectContainer(user, callback);
  });
};

/**
 * Answers /login endpoint, creates containers for new users; rejoins old
 * @param {Object} req    Web request
 * @param {Object} res    Web response
 */
server.get("/login", async (req, res) => {
  // Grab or create session data
  let user;
  session(req, {}, () => {
    user = req.headers["x-forwarded-user"] || req.session.user;
    userSession = req.session;
    userSession.user = user;
  });
  // If user has a container running, boot to that container
  let world = await containerData(user);
  // Otherwise, create a new container and proceed
  if(world.id === null) {
    // Get details necessary to start container
    readDirectory();
    startContainer(
      user
    );
  }
  await connectContainer(user, () => {
    res.redirect("/")
  });
});

/**
 * Answers / endpoint for created containers
 * @param {Object} req    Web request
 * @param {Object} res    Web response
 */
server.get("/*", async (req, res) => {
  let user;
  session(req, {}, () => {
    user = req.session.user;
  });
  if(user === undefined) res.redirect("/login");
  let world = await containerData(user);
  const proxy = httpProxy.createServer({});
  proxy.web(
    req,
    res,
    {target: `http://localhost:${world.port}/`}
  );
  proxy.on("error", (err, req, res) => {
    if (err) throw err;
    res.redirect("/login");
  });
  return;
});

/**
 * Handles transfer of HTTP to websocket
 * @param {Object} req      Web request
 * @param {Object} socket   Socket created
 * @param {Object} head     ?
 */
app.on("upgrade", async (req, socket, head) => {
  let user;
  session(req, {}, () => {
    user = req.session.user;
  });
  let proxy = httpProxy.createServer({});
  let world = await containerData(user);
  proxy.ws(
    req,
    socket,
    head,
    {target: `http://localhost:${world.port}/`}
  );
  proxy.on("error", (err, req, res) => {
    if (err) throw err;
    res.rediect("/login");
  });
  socket.on("ping", () => {
    socket.pong();
  });
  socket.on("data", () => {
    events.emit("lastActive",
      {
        [user]: {
          lastActive: now()
        }
      }
    )
  });
  socket.on("close", () => {
    socket.end();
    socket.destroy();
  });
  return;
});

// Activity monitoring

let timeout = process.env.TIMEOUT || 600;

setInterval( () => {
  const timed = Object
    .keys(activity)
    .filter((user, idx, self) => {
      return now() - activity[user].lastActive > timeout;
    });
  for(let entry in timed) {
    let user = timed[entry];
    events.emit("SIGUSER", user);
    delete activity[user];
  }
}, 10000);

// Prune patrol

setInterval( async () => {
  let list = await moby.listContainers({all: true});
  let pruned = await moby.pruneContainers({until: now()});
  let banished = pruned['ContainersDeleted'];
  const remove = Object
    .keys(activity)
    .filter((user, idx, self) => {
      if(banished) {
        return banished.indexOf(user);
      }
    });
  remove.forEach(user => {
    emitter.emit("SIGUSER", user);
  });
}, 10000);

// Container removal

const exit = () => {
  process.exit();
};

let interrupt;

const spindown = async (sig) => {
  let world = await containerData(sig[1]);
  let args = sig[0] == "USER" ? { filters: {"id":[`${world.id}`]} } : {all: true};
  delete activity[user];
  if(args.all) { interrupt = true; }
  let list = await moby.listContainers(args);
  for await(let entry of list) {
    let container = await moby.getContainer(entry.Id);
    let stoppage = await container.stop();
    let removal = await container.remove();
  }
  let pruned = await moby.pruneContainers({until: now()});
  if(args.all) { exit(); }
}

process.on("SIGINT", spindown.bind());
process.on("SIGTERM", spindown.bind());

// Nonce signal to indiate single user container shutdown

events.on("SIGUSER", (user) => {
  spindown(["USER", user]);
});
