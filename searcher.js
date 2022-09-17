const Docker = require("dockerode");
const ishmael = new Docker({socketPath: '/var/run/docker.sock'});

const search = async (user) => {
  console.log(`${user}`);
  let a = await ishmael.listContainers({filters:{"name": [user]}});
  for await(let entry of a){
    console.log(a)
  }
};

search("gatorwizard");
