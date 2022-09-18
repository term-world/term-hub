const docker = require("dockerode");
const moby = new docker({socketPath: '/var/run/docker.sock'});

const list = async(user) => {
  let containers = await moby.listContainers({filters: {"name": [user]}});
  for await(let entry of containers) {
    let acquired = await moby.getContainer(entry.Id);
    container = await acquired.inspect();
    console.log(container);
  }
  return undefined;
}
list("gatorwizard");
