const Docker = require("dockerode");
const ishmael = new Docker({socketPath: '/var/run/docker.sock'});

//ishmael.listContainers({all:true}, (err, containers) => {
//  containers.forEach((entry) => {
//    let container = ishmael.getContainer(entry.Id);
//    container.stop();
//  });
//});

let now = Math.floor(new Date().getTime() / 1000)
ishmael.pruneContainers({until: now})
