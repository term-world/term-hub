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

let app = http.createServer(server);
app.listen(8080);

let pid = 1000;
let ports = [];
let registry = { };

// Constants
let timeout = 1800000;

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

const connect = (user, fn) => {
  let port = registry[user].params.port
  http.get({ host: "0.0.0.0", port: port, path: `/` }, (res) => {
    fn();
  }).on('error', (err) => {
    console.log(err);
    connect(user, fn);
  });
};

const updateRegistry = (store) => {
  let user = store.user;
  let params = store.params;
  if(!registry[user]) registry[user] = { }
  if(!registry[user].params) registry[user].params = { }
  for(let param in params) {
    registry[user]["params"][param] = params[param]
  }
}

const cullIdle = () => {
  let time = (new Date()).getTime();
  for (let entry in registry) {
    let idle = time - registry[entry].params.active;
    if(idle > timeout) {
      remove(entry, () => { });
    }
  }
}

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
