/**
 * Publish the bridge's loopback port on the container's interface.
 *
 * The bridge pins its listen host — `host: "127.0.0.1"` is a literal in its
 * AppConfig — which is exactly right in a Kubernetes sidecar, where 9Router
 * shares the network namespace and reaches it over loopback. A sibling
 * container cannot, so under docker-compose this forwards one port.
 *
 * Off unless BRIDGE_PUBLISH_PORT is set: nothing should be listening on an
 * external interface unless someone asked for it.
 *
 *   node tcp-forward.mjs <listen-port> <target-port>
 */
import net from "node:net";

const [listenPort, targetPort] = process.argv.slice(2).map(Number);
if (!Number.isInteger(listenPort) || !Number.isInteger(targetPort)) {
  console.error("usage: tcp-forward.mjs <listen-port> <target-port>");
  process.exit(2);
}

const server = net.createServer((client) => {
  const upstream = net.connect(targetPort, "127.0.0.1");
  // Both directions piped, so backpressure is the kernel's problem and nothing
  // accumulates in this process.
  upstream.on("connect", () => {
    client.pipe(upstream);
    upstream.pipe(client);
  });
  const drop = () => { client.destroy(); upstream.destroy(); };
  client.on("error", drop);
  upstream.on("error", drop);
});

server.on("error", (error) => {
  console.error(`[forward] ${error.message}`);
  process.exit(1);
});

server.listen(listenPort, "0.0.0.0", () => {
  console.log(`[forward] 0.0.0.0:${listenPort} → 127.0.0.1:${targetPort}`);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => { server.close(); process.exit(0); });
}
