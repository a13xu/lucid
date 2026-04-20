// Shared SSE broadcast module — imported by orchestrator and worker routes
// to push real-time events to all connected browser clients.

export const sseClients = new Set();

export function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(msg);
    } catch {
      sseClients.delete(client);
    }
  }
}
