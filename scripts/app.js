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

// Setup global container run queue

/**
 * Event used to store last active times
 * @param {Object} store    Packet of active state info
 */
let activity = {}
events.on('lastActive', (store) => {
  activity[store.user] = { "lastActive": store.lastActive };
});

/**
 * Event used to enqueue and unqueue users
 * @params {String} user    User to add to queue
 */
let queue = [];
events.on("enqueueUser", (store) => {
  if(store.queued) queue.push(store.user);
  else queue.splice(queue.indexOf(store.user));
});
/**
 * Event used to register a user's proxied port
 * @params {String} user    User to query for port
 */
let proxies = {};
events.on("registerProxy", (store) => {
  if(!proxies[store.user]) proxies[store.user] = store.port;
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
  let containers = await moby.listContainers( {filters: {"name": [user]}} );
  for await(let entry of containers) {
    let acquired = await moby.getContainer(entry.Id);
    container = await acquired.inspect();
    return await {
      id: container.Id,
      name: container.Name.substring(1),
      port: container.NetworkSettings.Ports['8000/tcp'][0].HostPort
    }
  }
  return undefined;
};

/**
 * Discover extant containers and create a lastActive time
 * @function discoverContainers
 */
const discoverContainers = async () => {
  let containers = await moby.listContainers({all: true});
  for await(let entry of containers) {
    let acquired = await moby.getContainer(entry.Id);
    let container = await acquired.inspect();
    let user = container.Name.substring(1)
    events.emit("lastActive",
      {
        user: user,
        lastActive: now()
      }
    );
    events.emit("registerProxy",
      {
        user: user,
        port: container.NetworkSettings.Ports['8000/tcp'][0].HostPort
      }
    );
  }
}

discoverContainers();

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
  // TODO: Refresh the environment file
  // Read the directory over again
  readDirectory();
  // Provide start-up details
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
      },
      "CpuShares": 512
    }
  }, (err, data, container) => {
    // if (err.statusCode === 409) throw err;
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
  if (world !== undefined) {
    http.get({
      host: "0.0.0.0",
      port: world.port,
      path: "/"
    }, (res) => {
      callback();
    }).on("error", (err) => {
      connectContainer(user, callback);
    }).on("container", (container) => {
      console.log(container);
    });
  }
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
  let world = await containerData(user); // <-- consider synchronous or promise?
  // Otherwise, create a new container and proceed
  if(world === undefined && !queue.includes(user)) {
    // Get details necessary to start container
    readDirectory();
    startContainer(user);
    // Queue user
    events.emit("enqueueUser", {user: user, queued: true});
    let container;
    do {
        container = await containerData(user);
    } while(!container);
  }
  await connectContainer(user, () => {
    res.redirect("/");
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
    user = req.session.user || req.headers["x-forwarded-user"]
    if(user === undefined) res.redirect("/login");
  });

  let world = await containerData(user);
  if (world === undefined) res.redirect("/login");

  const proxy = httpProxy.createServer({});
  events.emit("registerProxy",
    {user: user, port: world.port}
  );
  proxy.web(
    req,
    res,
    {target: `http://localhost:${world.port}/`}
  );

  proxy.on("error", (err, req, res) => {
    console.log("Errrrrr");
  });
});

/**
 * Handles transfer of HTTP to websocket
 * @param {Object} req      Web request
 * @param {Object} socket   Socket created
 * @param {Object} head     ?
 */
app.on("upgrade", async (req, socket, head) => {
  let user = req.headers["x-forwarded-user"];
  let proxy = httpProxy.createServer({});
  proxy.ws(
    req,
    socket,
    head,
    {target: `http://localhost:${proxies[user]}/`}
  );
  proxy.on("error", (err, req, res) => {
    //res.rediect("/login");
  });
  socket.on("ping", () => {
    socket.pong();
  });
  socket.on("data", () => {
    events.emit("lastActive",
      {
        user: user,
        lastActive: now()
      }
    )
  });
  socket.on("close", () => {
    socket.end();
    socket.destroy();
  });

  // Remove user from start queue
  events.emit("enqueueUser", {user: user, queue: false});
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
  let pruned = await moby.pruneContainers({until: now()});
  let banished = pruned['ContainersDeleted'];
  const remove = Object
    .keys(activity)
    .filter((user, idx, self) => {
      if(banished) return banished.indexOf(user);
    });
  remove.forEach(user => {
    delete activity[user];
    delete proxies[user];
  });
}, 10000);

// Container removal

const exit = () => {
  process.exit();
};

const spindown = async (sig) => {
  let world = await containerData(sig[1]);
  let args = sig[0] == "USER" ? { filters: {"id":[`${world.id}`]} } : {all: true};
  delete activity[world.name];
  delete proxies[world.name];
  let list = await moby.listContainers(args);
  for await(let entry of list) {
    let container = await moby.getContainer(entry.Id);
    let stoppage = await container.stop();
    let removal = await container.remove();
  }
  let pruned = await moby.pruneContainers({until: now()});
  if(args.all) { exit(); }
}

// Removing all-kill when hub shuts down to preserve user connectivity

//process.on("SIGINT", spindown.bind());
//process.on("SIGTERM", spindown.bind());

// Nonce signal to indiate single user container shutdown

events.on("SIGUSER", (user) => {
  spindown(["USER", user]);
});
