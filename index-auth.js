// OAuth2 verification through GitHub
const passport = require('passport');
      GitHub = require('passport-github').Strategy;

// Server setup
const express = require('express');
      cookies = require('cookie-parser');
      sessions = require('express-session');
      crypto = require("crypto");
      http = require("http");
      proxy = require("http-proxy");

session = sessions({
  secret: crypto.randomBytes(10).toString("hex"),
  resave: true,
  saveUninitialized: true
});

server = express()

server.use(session);
server.use(cookies());
server.use(passport.initialize());
server.use(passport.session());

server.set('views', `${__dirname}/views`);
server.set('view engine', 'ejs');

app = server.listen(4180, ()=> { })
webProxy = proxy.createProxyServer({ });

// Get credentials from .env file
require('dotenv').config()

// Globals
const image = "world"
      users = {}
      tokens = {}
      addresses = {}
      containers = {}
      ports = ['4180','8080']

// Docker
const Docker = require("dockerode");
const docker = new Docker({socketPath: '/var/run/docker.sock'});

// Helper functions

const acquireIP = (container, callback) => {
  container.inspect((err,data) => {
    let ip = data.NetworkSettings.Networks.bridge.IPAddress;
    if(!ip){
      acquireIP(container, callback);
    } else {
      callback(ip);
    }
  });
}

const connect = (address, port, callback) => {
  http.get({host: address, port: port, path: "/"}, (res) => {
    callback();
  }).on('error', (e) => {
    connect(address, port, callback);
  });
}

const codeServer = http.createServer(server);
codeServer.listen(8080);

// OAuth2 process via passport and passport-github
passport.use(new GitHub({
  clientID: process.env.GITHUB_CLIENT_ID,
  clientSecret: process.env.GITHUB_CLIENT_SECRET,
  callbackURL: process.env.GITHUB_CALLBACK_URL
},
  (access, refresh, profile, callback) => {
    return callback(null, profile);
  }
));

passport.serializeUser((user, callback) => {
  users[user.id] = user;
  callback(null, user.id);
});

passport.deserializeUser((user, callback) => {
  if(user in users) {
    callback(null, users[user])
  }
});

server.get('/login', passport.authenticate('github'));

server.get('/oauth2/callback', passport.authenticate('github', {failureRedirect: '/'}), (req, res) => {
  let token = crypto.randomBytes(15).toString("hex");
  tokens[req.user.id] = token;
  docker.run(
    image,
    [],
    undefined,
    {
      "Hostname":"term-world",
      "Env":[
        "VS_USER=" + req.user.username
      ],
      "Binds":[
        `/home/${req.user.username}:/home/${req.user.username}`
      ]
    }, (err, data, container) => {
      console.log("CONTAINER ERROR.");
    }).on('container', (container) => {
      containers[token] = container;
      acquireIP(container, (address) => {
        addresses[token] = address;
        connect(
          address,
          8080,
          () => {
            res.redirect('/');
          }
        );
      });
    });
});

server.get('/', (req, res) => {
  if(req.user) {
    var token = tokens[req.user.id];
    webProxy.web(req, res, {target: `http://${addresses[token]}:8080`});
  } else {
    res.render("login");
  }
});

codeServer.on("upgrade", (req, socket, head) => {
  session(req, {}, () => {
    var user = req.session.passport.user;
    webProxy.ws(req, socket, head, {target: `ws://${addresses[tokens[user.id]]}:8080`});
    socket.on("data", () => {
      // TODO: Socket data time update?
    });
  });
});

codeServer.on("error", err => console.log(err));
