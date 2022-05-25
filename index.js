// OAuth2 verification through GitHub
const passport = require('passport');
      GitHub = require('passport-github').Strategy;

// Server setup
const express = require('express');
      sessions = require('express-session');
      crypto = require("crypto");
      session = sessions({
        secret: "16335",
        resave: true,
        saveUninitialized: true
      });
      server = express()
      server.use(session);
      app = server.listen(4180, ()=> { })

// Get credentials from .env file
require('dotenv').config()

// Globals
const image = "world"
      users = {}
      tokens = {}
      ports = ['4180','8080']
      addresses = ['127.0.0.1']

// Docker
const Docker = require("dockerode")
const docker = new Docker({socketPath: '/var/run/docker.sock'});

// Helper functions

const openPort = () => {
  let port = Math.floor(1000 + Math.random() * 9000);
  if(!ports.includes(port)){
    return port;
  }
  openPort();
}

const makeAddress = () => {
  //TODO: Make addresses
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

server.get('/', passport.authenticate('github'));

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
      "Mounts":[
        {
          "Type": "bind",
          "Source": "/home/" + req.user.username,
          "Target": "/home/" + req.user.username
        }
      ],
      "Ports":[
        {
          "PublicPort": openPort(),
          "PrivatePort": 8080,
          "Type": "tcp"
        }
      ],
      "NetworkSettings": {
        "IPAddress": makeAddress()
      }
    }
  ).then((data) => {
    console.log(data);
  }).catch((err) => {
    console.log(err);
  });
});
