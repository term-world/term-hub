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

app = server.listen(4180, ()=> { })
webProxy = proxy.createProxyServer({ });

// Get credentials from .env file
require('dotenv').config()

// Globals
const image = "world"
      users = {}
      tokens = {}
      addresses = {}
      ports = ['4180','8080']

// Docker
const Docker = require("dockerode");
const docker = new Docker({socketPath: '/var/run/docker.sock'});

// Helper functions
const addPorts = (uid) => {
  let port = 1000;
  if(!ports.hasOwnProperty(port)){
    ports[uid] = port
    return port;
  }
  port++;
}

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

server.get("/", (req, res) => {
  if(req.user){
    let token = tokens[req.user.id];
    webProxy.web(req, res, {target: `http://${addresses[token]}:$ports[req.user.id]`});
  } else {
    res.redirect("/login");
  }
});

server.get('/oauth2/callback', passport.authenticate('github', {failureRedirect: '/'}), (req, res) => {
  let token = crypto.randomBytes(15).toString("hex");
  tokens[req.user.id] = token;
  ports[token] = addPorts(req.user.id);
  docker.run(
    image,
    [],
    undefined,
    {
      "Hostname":"term-world",
      "Env":[
        "VS_USER=" + req.user.username
      ],
      "Mounts":[
        {
          "Type": "bind",
          "Source": "/home/" + req.user.username,
          "Target": "/home/" + req.user.username
        }
      ]
    }, (err, data, container) => {
      console.log("CONTAINER ERROR.");
    }).on('container', (container) => {
      acquireIP(container, (address) => {
        addresses[token] = address;
        connect(
          address,
          ports[token],
          () => {
            res.redirect('/');
          }
        );
      });
    });
});
