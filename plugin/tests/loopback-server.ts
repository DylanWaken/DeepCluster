/** Bind a loopback test listener on a port the Fetch standard does not block. */
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

/** Ports a Fetch request refuses before connecting; an ephemeral test port can fall in this set. */
const FETCH_BAD_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104,
  109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515,
  526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049,
  3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
])

/**
 * Listen on one ephemeral loopback port, retrying when the operating system assigns a port
 * that Fetch rejects as unsafe so a spec never depends on which ephemeral port is free.
 * @param server - HTTP server owned by the spec.
 * @returns the bound loopback address.
 */
export async function listenLoopback(server: Server): Promise<AddressInfo> {
  for (let attempt = 0; attempt < 10; attempt++) {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('loopback test listener has no TCP address')
    if (!FETCH_BAD_PORTS.has(address.port)) return address
    await new Promise<void>((resolve, reject) => { server.close((error) => { if (error === undefined) resolve(); else reject(error) }) })
  }
  throw new Error('could not bind a loopback port that Fetch accepts')
}
