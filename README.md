# `term-world`: `term-hub`

This work is based largely on [rafket's VSCode-Hub](https://github.com/rafket/vscode-hub/). This version does without implementing authentication in the `nodejs` daemon. OAuth
proxying is handled by `oauth2_proxy`.

## Functionality

`term-hub` uses `dockerode` to start containers once a proxied login occurs successfuly. It starts one container per user, given that the user in question doesn't already have
a container running. These containers feature a two-way mount to a server's file system, meaning that the only reason for the container is to provide an isolated instance
of `cdr/code-server` or, essentially, VS Code in the browser.
